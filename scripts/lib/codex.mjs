// The capture worker's core for Codex: once a queued turn has ended, forks the
// session after it through `codex app-server` so the model can save what the
// turn taught as a skill. The fork runs read-only, every approval but
// manage_skill's is denied, and Codex never saves it.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { boundedSink, forkEnvironment, isDirectory, noteToolName, requestedSave, skillChanges } from "./capture.mjs";
import { PLUGIN_VERSION } from "./config.mjs";
import { captureNudge } from "./prompts.mjs";
import { findTurnEnd } from "./rollout.mjs";
import { isValidSessionId } from "./state.mjs";
import { clip } from "./transcript.mjs";

const PLUGIN_DIR = fileURLToPath(new URL("../..", import.meta.url));
/** The MCP server's name in codex/mcp.json. */
const MCP_SERVER = "auto-learn";
const MANAGE_SKILL = "manage_skill";
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 500;
const MAX_VALUE_CHARS = 256;
/** The review is asked to use manage_skill alone, so a fork that calls more other tools than this has gone on with the task. */
const MAX_OTHER_TOOL_CALLS = 3;
const EFFORT_LEVEL = /^[a-z]+$/;
/** The app-server items of subagent tools, multi_agent_v1's and multi_agent_v2's. */
const SUB_AGENT_ITEMS = new Set(["collabAgentToolCall", "subAgentActivity"]);
/** The app-server items that are tool calls; the fork's manage_skill calls are counted apart. */
const TOOL_ITEMS = new Set([
	"commandExecution",
	"fileChange",
	"mcpToolCall",
	"dynamicToolCall",
	"collabAgentToolCall",
	"subAgentActivity",
	"webSearch",
	"imageView",
	"imageGeneration",
]);

/**
 * The id Codex gives the plugin, `<plugin>@<marketplace>`, read from where
 * Codex installed it: <CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>.
 * Undefined when `pluginDir` does not follow that layout, as in a checkout, or
 * when the id holds a dot.
 */
export function codexPluginId(pluginDir) {
	const pluginFolder = path.dirname(path.resolve(pluginDir));
	const marketplaceFolder = path.dirname(pluginFolder);
	const cache = path.dirname(marketplaceFolder);
	if (path.basename(cache) !== "cache" || path.basename(path.dirname(cache)) !== "plugins") return undefined;
	const id = `${path.basename(pluginFolder)}@${path.basename(marketplaceFolder)}`;
	// Codex splits a configuration key at each dot, so an id with one cannot name the plugin's settings.
	return id.includes(".") ? undefined : id;
}

/**
 * Captures one queued Codex turn: waits until the turn has ended, then forks
 * the session after it. Codex runs the Stop hooks again for a turn that one
 * of them continues, which queues the turn again, so `reviewedTurns` holds the
 * turns this worker has forked. The returned record holds no transcript text,
 * so it is safe to log.
 */
export async function captureCodexTurn(job, { env = process.env, signal, reviewedTurns = new Set(), pluginId = codexPluginId(PLUGIN_DIR) } = {}) {
	if (!isWellFormed(job)) return { outcome: "skipped", reason: "malformed job" };
	if (reviewedTurns.has(job.turnId)) return { outcome: "skipped", reason: "the turn was already reviewed" };
	// Without the plugin's id the fork cannot approve manage_skill, so the review could save nothing.
	if (!pluginId) return { outcome: "skipped", reason: "the plugin does not run from a Codex plugin install, or its id holds a dot, so the fork cannot approve manage_skill" };
	const turnEnd = await findTurnEnd(job.transcriptPath, { end: job.end, turnId: job.turnId, signal });
	if (signal?.aborted) return { outcome: "aborted", reason: String(signal.reason) };
	if (turnEnd.skip) return { outcome: "skipped", reason: turnEnd.skip };
	if (!(await isDirectory(job.projectDir))) return { outcome: "skipped", reason: "the session's project directory is gone" };
	reviewedTurns.add(job.turnId);

	const started = performance.now();
	const { saves = [], ...result } = await runCodexFork({
		threadId: job.sessionId,
		turnId: job.turnId,
		model: isShortText(job.model) ? job.model : undefined,
		effort: typeof job.effort === "string" && EFFORT_LEVEL.test(job.effort) ? job.effort : undefined,
		modelProvider: isShortText(job.modelProvider) ? job.modelProvider : undefined,
		cwd: job.projectDir,
		env,
		signal,
		pluginId,
	});
	const durationMs = Math.round(performance.now() - started);
	return { ...result, ...skillChanges(saves), durationMs };
}

function isWellFormed(job) {
	return (
		isValidSessionId(job?.sessionId) &&
		typeof job.transcriptPath === "string" &&
		job.transcriptPath !== "" &&
		Number.isSafeInteger(job.end) &&
		job.end >= 0 &&
		isShortText(job.turnId) &&
		typeof job.projectDir === "string" &&
		job.projectDir !== ""
	);
}

function isShortText(value) {
	return typeof value === "string" && value !== "" && value.length <= MAX_VALUE_CHARS;
}

/**
 * The fork's configuration overrides: no hooks and no notify program, since
 * the fork is no session of the user's; the user as the approvals reviewer,
 * since automatic review would still judge requests that the never policy
 * denies; and manage_skill approved, so the review can save a skill while
 * every other approval is denied.
 */
export function forkConfig(pluginId) {
	return {
		"features.hooks": false,
		notify: [],
		approvals_reviewer: "user",
		[`plugins.${pluginId}.mcp_servers.${MCP_SERVER}.tools.${MANAGE_SKILL}.approval_mode`]: "approve",
	};
}

/**
 * Runs the capture fork: `codex app-server` forks the session after turn
 * `turnId` into an ephemeral thread and starts a turn on it with the capture
 * request. The fork loads the user's configuration, plugins and tools, as the
 * session did, so its request reuses the session's prompt cache. A fork that
 * calls more than MAX_OTHER_TOOL_CALLS tools besides manage_skill, or starts a
 * subagent tool, is stopped. A failure comes back as the record's outcome
 * rather than an exception, so one bad capture never stops the queue; once the
 * fork exists, the record holds the calls, token use and saves it reported,
 * however it ended. `saves` lists the fork's successful manage_skill calls in
 * order, and `otherTools` names its other tools, as many as noteToolName
 * keeps, without their arguments or output. Other tools count once Codex
 * reports them finished, a subagent tool once it starts. The protocol was
 * verified with Codex 0.168. The status and arguments of mcpToolCall items and
 * the subagent items come from the Codex 0.169.0 source; a run of a 0.169.0
 * build showed all of them but multi_agent_v2's subAgentActivity.
 *
 * @returns {Promise<{outcome: "ok" | "error" | "timeout" | "aborted" | "stopped", skillCalls?: number, otherToolCalls?: number, inputTokens?: number, cacheReadTokens?: number, outputTokens?: number, saves?: Array<{action: string, name: string}>, otherTools?: string[], reason?: string, error?: string}>}
 */
export function runCodexFork({ threadId, turnId, model, effort, modelProvider, cwd, env, signal, pluginId, timeoutMs = CAPTURE_TIMEOUT_MS }) {
	return new Promise((resolve) => {
		const child = spawn("codex", ["app-server"], { cwd, env: codexForkEnvironment(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const stderr = boundedSink(child.stderr, MAX_STDERR_BYTES);
		const calls = { skillCalls: 0, otherToolCalls: 0 };
		const saves = [];
		const otherTools = new Set();
		const usage = {};
		const requests = new Map();
		let lastRequestId = 0;
		let forkId;
		let forkTurnId;
		let record;
		let killTimer;

		// `result` is what the capture reports once the stopped app-server has exited.
		const stop = (result, graceMs) => {
			if (record) return;
			record = result;
			child.stdin.end();
			killTimer = setTimeout(() => {
				child.kill("SIGTERM");
				killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
			}, graceMs);
		};
		const timer = setTimeout(() => stop({ outcome: "timeout" }, 0), timeoutMs);
		const onAbort = () => stop({ outcome: "aborted", reason: String(signal.reason) }, 0);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (result) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			if (typeof forkId !== "string") resolve(result);
			else resolve({ ...result, ...calls, ...tokenCounts(usage), saves: [...saves], otherTools: [...otherTools] });
		};
		child.once("error", (error) =>
			finish({ outcome: "error", error: error.code === "ENOENT" ? "the codex CLI was not found on PATH" : error.message }),
		);
		child.once("close", (code, exitSignal) => {
			const detail = stderr().trim().slice(-MAX_ERROR_CHARS) || "no error output";
			finish(record ?? { outcome: "error", error: `codex app-server exited (${code ?? exitSignal}) before the review ended: ${detail}` });
		});
		// The app-server may exit before reading every message; its exit status tells why.
		child.stdin.on("error", () => {});

		const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
		const request = (method, params, onResult) => {
			const id = ++lastRequestId;
			requests.set(id, { method, onResult });
			send({ id, method, params });
		};
		const onResponse = ({ id, result, error }) => {
			const pending = requests.get(id);
			if (!pending) return;
			requests.delete(id);
			if (error !== undefined) {
				stop({ outcome: "error", error: clip(`codex app-server refused ${pending.method}: ${error?.message ?? JSON.stringify(error)}`, MAX_ERROR_CHARS) }, 0);
			} else {
				pending.onResult(result);
			}
		};
		const onNotification = (method, params) => {
			if (forkId === undefined || params?.threadId !== forkId) return;
			switch (method) {
				case "turn/started":
					forkTurnId ??= params.turn?.id;
					break;
				case "item/started":
					// A subagent runs on its own thread, so its calls, tokens and saves would escape the review's limit and log.
					if (SUB_AGENT_ITEMS.has(params.item?.type)) {
						calls.otherToolCalls++;
						noteToolName(otherTools, toolName(params.item));
						stop({ outcome: "stopped", reason: "the review tried to use a subagent" }, 0);
					}
					break;
				case "item/completed": {
					const item = params.item;
					if (item?.type === "mcpToolCall" && item.server === MCP_SERVER && item.tool === MANAGE_SKILL) {
						calls.skillCalls++;
						// Codex reports a declined or failed call, and one whose result has isError, as "failed".
						const save = item.status === "completed" ? requestedSave(item.arguments) : undefined;
						if (save) saves.push(save);
					} else if (TOOL_ITEMS.has(item?.type) && !SUB_AGENT_ITEMS.has(item.type)) {
						calls.otherToolCalls++;
						noteToolName(otherTools, toolName(item));
						if (calls.otherToolCalls > MAX_OTHER_TOOL_CALLS) {
							stop({ outcome: "stopped", reason: `the review called more than ${MAX_OTHER_TOOL_CALLS} tools other than ${MANAGE_SKILL}` }, 0);
						}
					}
					break;
				}
				case "thread/tokenUsage/updated":
					// An update for another turn, such as the session's last one, is not the fork's.
					if (forkTurnId === undefined || params.turnId !== forkTurnId) break;
					usage.first ??= params.tokenUsage;
					usage.last = params.tokenUsage;
					break;
				case "turn/completed": {
					const turn = params.turn ?? {};
					if (forkTurnId !== undefined && turn.id !== forkTurnId) break;
					const ending =
						turn.status === "completed"
							? { outcome: "ok" }
							: { outcome: "error", error: clip(turn.error?.message || `the fork's turn ended as ${turn.status}`, MAX_ERROR_CHARS) };
					stop(ending, KILL_GRACE_MS);
					break;
				}
				default:
					break;
			}
		};

		readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				// Not a protocol message, so nothing to act on.
				return;
			}
			if (message === null || typeof message !== "object") return;
			if (typeof message.method === "string" && message.id !== undefined) {
				// A request the fork should never need, such as an approval: the policy denies them all.
				send({ id: message.id, error: { code: -32601, message: `auto-learn does not answer ${message.method}` } });
			} else if (typeof message.method === "string") {
				onNotification(message.method, message.params);
			} else {
				onResponse(message);
			}
		});

		request("initialize", { clientInfo: { name: "auto-learn", title: "auto-learn", version: PLUGIN_VERSION } }, () => {
			send({ method: "initialized" });
			const forkParams = {
				threadId,
				lastTurnId: turnId,
				ephemeral: true,
				excludeTurns: true,
				approvalPolicy: "never",
				sandbox: "read-only",
				cwd,
				config: forkConfig(pluginId),
				...(model ? { model } : {}),
				...(modelProvider ? { modelProvider } : {}),
			};
			request("thread/fork", forkParams, (result) => {
				forkId = result?.thread?.id;
				if (typeof forkId !== "string") {
					stop({ outcome: "error", error: "codex app-server returned no thread for the fork" }, 0);
					return;
				}
				const input = [{ type: "text", text: captureNudge(MANAGE_SKILL, "codex") }];
				request("turn/start", { threadId: forkId, input, ...(effort ? { effort } : {}) }, (started) => {
					forkTurnId ??= started?.turn?.id;
				});
			});
		});
	});
}

/** The capture fork's environment, without the plugin locations Codex gives the hooks of the session. */
function codexForkEnvironment(env) {
	const result = forkEnvironment(env);
	delete result.PLUGIN_ROOT;
	delete result.PLUGIN_DATA;
	return result;
}

/** A tool item's name for the log: the item type, or the server or namespace and tool of an MCP or dynamic tool call. */
function toolName(item) {
	// Neither an MCP server's name nor a dynamic tool's namespace can hold "#", so each name reads one way.
	if (item.type === "mcpToolCall") return `mcp:${item.server}#${item.tool}`;
	if (item.type === "dynamicToolCall") return `dynamic:${item.namespace ? `${item.namespace}#` : ""}${item.tool}`;
	return item.type;
}

/**
 * The fork's own token use. Codex reports a running total for the thread,
 * which a fork starts from the session's total, and the last request's use:
 * the fork used its final total less its first total, plus its first request.
 */
function tokenCounts({ first, last }) {
	if (!first || !last) return {};
	const counts = {};
	for (const [name, key] of [
		["inputTokens", "inputTokens"],
		["cacheReadTokens", "cachedInputTokens"],
		["outputTokens", "outputTokens"],
	]) {
		const value = last.total?.[key] - first.total?.[key] + first.last?.[key];
		if (Number.isFinite(value)) counts[name] = value;
	}
	return counts;
}
