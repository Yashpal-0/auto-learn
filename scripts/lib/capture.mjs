// The capture worker's core: takes a session's queued turns oldest first and,
// once each turn has ended, forks the session there so Claude can save what
// the turn taught as a skill, with every tool but manage_skill refused.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { lineSplitter, parseLine, readLines } from "./jsonl.mjs";
import { captureNudge } from "./prompts.mjs";
import { parseName } from "./skills.mjs";
import { acquireLock, hasJob, takeJob } from "./state.mjs";
import { clip, findForkPoint } from "./transcript.mjs";

/** The name Claude Code gives manage_skill: mcp__plugin_<plugin>_<server>__<tool>. */
export const MANAGE_SKILL_TOOL = "mcp__plugin_auto-learn_auto-learn__manage_skill";
// ToolSearch loads manage_skill's schema when Claude Code defers MCP tools.
const ALLOWED_TOOLS = [MANAGE_SKILL_TOOL, "ToolSearch"];
// It is echoed between single quotes, so it must not contain one.
const REFUSAL = "Only manage_skill can run during an automatic skill review; nothing was run.";
/**
 * Settings for the fork: a PreToolUse hook that refuses every other tool, even
 * ones the user's settings allow, and still refuses when the hook itself fails
 * or times out ("onFailure" needs Claude Code 2.1.295 or later).
 */
export const GATE_SETTINGS = JSON.stringify({
	hooks: {
		PreToolUse: [
			{
				matcher: `^(?!(${ALLOWED_TOOLS.join("|")})$).*$`,
				hooks: [{ type: "command", command: `echo '${REFUSAL}' >&2; exit 2`, timeout: 10, onFailure: "block" }],
			},
		],
	},
});
// What Claude Code tells its hooks about the session that ran them; the fork is a session of its own.
const PARENT_SESSION_VARIABLES = new Set([
	"AI_AGENT",
	"CLAUDECODE",
	"CLAUDE_CODE_BRIDGE_SESSION_ID",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_EVAL_INTERVIEW_SESSION",
	"CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_HOST_WORKTREE",
	"CLAUDE_CODE_HOST_WORKTREE_FENCE",
	"CLAUDE_CODE_INVOKED_SKILLS",
	"CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_MESSAGING_TOKEN",
	"CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_EFFORT",
	"CLAUDE_ENV_FILE",
	"CLAUDE_PID",
	"CLAUDE_PLUGIN_DATA",
	"CLAUDE_PLUGIN_ROOT",
	"CLAUDE_PROJECT_DIR",
	"TRACEPARENT",
]);
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const MAX_TURNS = 10;
const MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_LOGGED_TOOL_NAMES = 10;
const MAX_LOGGED_TOOL_NAME_CHARS = 256;
/** For each manage_skill action that changes a skill: what it leaves a skill's change as, given what the review's earlier calls left. */
const SAVE_CHANGES = {
	create: (earlier) => (earlier === "deleted" ? "updated" : "created"),
	update: (earlier) => (earlier === "created" ? "created" : "updated"),
	delete: (earlier) => (earlier === "created" ? undefined : "deleted"),
};
const MAX_ERROR_CHARS = 500;
const MAX_ARGUMENT_CHARS = 256;
const EFFORT_LEVEL = /^[a-z]+$/;

/**
 * Runs `runJob` on each job queued for the session, oldest first, until the
 * queue is empty or `signal` aborts. Returns at once while another live
 * worker holds the session's lock, since that worker drains the queue.
 */
export async function drainQueue(dir, sessionId, runJob, signal) {
	for (;;) {
		const lock = await acquireLock(dir, sessionId);
		if (!lock) return;
		try {
			while (!signal?.aborted) {
				const job = await takeJob(dir, sessionId);
				if (!job) break;
				await lock.refresh();
				await runJob(job);
			}
		} finally {
			await lock.release();
		}
		// A worker started just before the release found the lock held and left its job behind.
		if (signal?.aborted || !(await hasJob(dir, sessionId))) return;
	}
}

/**
 * Captures one queued turn: waits until the turn has ended, then forks the
 * session at its last entry. The returned record holds no transcript text,
 * so it is safe to log.
 */
export async function captureTurn(job, { env = process.env, signal } = {}) {
	if (!isWellFormed(job)) return { outcome: "skipped", reason: "malformed job" };
	const forkPoint = await findForkPoint(job.transcriptPath, { start: job.start, end: job.end, signal });
	if (signal?.aborted) return { outcome: "aborted", reason: String(signal.reason) };
	if (forkPoint.skip) return { outcome: "skipped", reason: forkPoint.skip };
	if (!isSafeArgument(forkPoint.uuid)) return { outcome: "skipped", reason: "the turn's last entry has an unusable id" };
	if (!(await isDirectory(job.projectDir))) return { outcome: "skipped", reason: "the session's project directory is gone" };

	const started = performance.now();
	const { saves, ...record } = await runFork({
		sessionId: job.sessionId,
		transcriptPath: job.transcriptPath,
		forkAt: forkPoint.uuid,
		model: isSafeArgument(forkPoint.model) ? forkPoint.model : undefined,
		effort: typeof job.effort === "string" && EFFORT_LEVEL.test(job.effort) ? job.effort : undefined,
		cwd: job.projectDir,
		env,
		signal,
	});
	const durationMs = Math.round(performance.now() - started);
	return { ...record, ...skillChanges(saves), durationMs };
}

function isWellFormed(job) {
	return (
		isSafeArgument(job?.sessionId) &&
		typeof job.transcriptPath === "string" &&
		job.transcriptPath !== "" &&
		Number.isSafeInteger(job.start) &&
		Number.isSafeInteger(job.end) &&
		job.start >= 0 &&
		job.start <= job.end &&
		typeof job.projectDir === "string" &&
		job.projectDir !== ""
	);
}

/** Whether `value` can follow a flag on claude's command line without being read as a flag itself. */
function isSafeArgument(value) {
	return typeof value === "string" && value !== "" && value.length <= MAX_ARGUMENT_CHARS && !value.startsWith("-");
}

export async function isDirectory(target) {
	try {
		return (await fs.stat(target)).isDirectory();
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
		throw error;
	}
}

/**
 * The {action, name} of a manage_skill call that changes a skill, from the
 * call's input, or undefined for a call that changes none or that a later
 * store may support.
 *
 * @returns {{action: "create" | "update" | "delete", name: string} | undefined}
 */
export function requestedSave(input) {
	return Object.hasOwn(SAVE_CHANGES, input?.action) && typeof input.name === "string" ? { action: input.action, name: input.name } : undefined;
}

/**
 * The managed skills a review created, updated and deleted, from its own
 * successful manage_skill calls in the order they ran, by the names the store
 * saved them under. A skill created and deleted again in one review is left
 * out; one deleted and created again counts as updated.
 *
 * @param {Array<{action: "create" | "update" | "delete", name: string}>} saves requestedSave values of the calls that succeeded.
 */
export function skillChanges(saves) {
	const changes = new Map();
	for (const { action, name: rawName } of saves) {
		if (!Object.hasOwn(SAVE_CHANGES, action)) throw new Error(`skillChanges got the unknown manage_skill action ${JSON.stringify(action)}.`);
		const name = parseName(rawName);
		const change = SAVE_CHANGES[action](changes.get(name));
		if (change === undefined) changes.delete(name);
		else changes.set(name, change);
	}
	const named = (kind) => [...changes].filter(([, change]) => change === kind).map(([name]) => name);
	return { created: named("created"), updated: named("updated"), deleted: named("deleted") };
}

/**
 * Runs the capture fork: `claude -p` resumes the session up to `forkAt` as a
 * new session that is never saved, and gets the capture request as its next
 * prompt. The fork loads the user's settings, plugins and tools, as the
 * session did, so its request reuses the session's prompt cache; the gate
 * hook refuses every tool but manage_skill and ToolSearch. A failure comes
 * back as the record's outcome rather than an exception, so one bad capture
 * never stops the queue. claude prints each message as it goes, so a fork
 * stopped before its result still reports what its replies so far used and
 * the skills it saved. `saves` holds the fork's own successful manage_skill
 * calls, and never another session's. The flags and the init, assistant and
 * result lines were verified with Claude Code 2.1.325; the tool_use and
 * tool_result blocks follow the Messages API and were not seen in a live run.
 *
 * @returns {Promise<{outcome: "ok" | "error" | "timeout" | "aborted", turns?: number, costUsd?: number, sessionCostUsd?: number, reportedCostUsd?: number, inputTokens?: number, cacheReadTokens?: number, outputTokens?: number, advisorCalls?: number, refusedCalls?: number, refusedTools?: string[], reason?: string, error?: string, saves: Array<{action: "create" | "update" | "delete", name: string}>}>}
 */
export async function runFork({ sessionId, transcriptPath, forkAt, model, effort, cwd, env, signal, timeoutMs = CAPTURE_TIMEOUT_MS }) {
	const args = [
		"-p",
		"--resume",
		sessionId,
		"--resume-session-at",
		forkAt,
		"--fork-session",
		"--no-session-persistence",
		"--output-format",
		"stream-json",
		"--verbose",
		"--permission-mode",
		"dontAsk",
		"--allowedTools",
		...ALLOWED_TOOLS,
		"--settings",
		GATE_SETTINGS,
		"--max-turns",
		String(MAX_TURNS),
		...(model ? ["--model", model] : []),
		...(effort ? ["--effort", effort] : []),
	];
	// Read just before the fork starts, since the fork restores its cost counters from what the transcript holds then.
	const sessionCost = await sessionCostState(transcriptPath, sessionId);
	return new Promise((resolve) => {
		const child = spawn("claude", args, { cwd, env: forkEnvironment(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const review = { replies: new Map(), pendingSaves: new Map(), saves: [], advisorCalls: 0, refusedCalls: 0, refusedTools: new Set() };
		let ending;
		child.stdout.on(
			"data",
			lineSplitter(MAX_STDOUT_LINE_BYTES, (line) => {
				const message = parseLine(line);
				if (message?.type === "result") ending = resultRecord(message, sessionCost, review);
				else foldMessage(review, message);
			}),
		);
		const stderr = boundedSink(child.stderr, MAX_STDERR_BYTES);
		let stopped;
		let killTimer;
		// `record` is what the capture reports once the stopped child has exited.
		const stopChild = (record) => {
			if (stopped) return;
			stopped = record;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		};
		const timer = setTimeout(() => stopChild({ outcome: "timeout" }), timeoutMs);
		const onAbort = () => stopChild({ outcome: "aborted", reason: String(signal.reason) });
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (record) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...record, saves: review.saves });
		};
		child.once("error", (error) =>
			finish({ outcome: "error", error: error.code === "ENOENT" ? "the claude CLI was not found on PATH" : error.message }),
		);
		child.once("close", (code, exitSignal) => {
			// A result that came before the stop says how the fork ended.
			if (ending) return finish(ending);
			if (stopped) return finish({ ...stopped, turns: review.replies.size, ...summedTokens(review.replies), ...toolCalls(review) });
			// stderr only: stdout holds the fork's replies, which the log must not.
			const detail = stderr().trim().slice(-MAX_ERROR_CHARS) || "no error output";
			finish({ outcome: "error", error: `claude ended without a result (exit ${code ?? exitSignal}): ${detail}` });
		});
		// claude may exit before reading the whole request; its exit status tells why.
		child.stdin.on("error", () => {});
		child.stdin.end(captureNudge(MANAGE_SKILL_TOOL));
	});
}

/** The environment for a capture fork: the session's, less what the agent tells hooks about the session that ran them. */
export function forkEnvironment(env) {
	const result = {};
	for (const [key, value] of Object.entries(env)) {
		if (!PARENT_SESSION_VARIABLES.has(key) && !key.startsWith("CLAUDE_PLUGIN_OPTION_")) result[key] = value;
	}
	return { ...result, AUTO_LEARN_CAPTURE: "1" };
}

/** Collects up to `limit` bytes of a stream and returns a function that reads them as text. */
export function boundedSink(stream, limit) {
	const chunks = [];
	let size = 0;
	stream.on("data", (chunk) => {
		if (size >= limit) return;
		chunks.push(chunk.subarray(0, limit - size));
		size += Math.min(chunk.length, limit - size);
	});
	return () => Buffer.concat(chunks).toString("utf8");
}

/**
 * Takes in one message the fork printed: the usage of each reply, its advisor
 * calls, which run on the server where no hook can refuse them, the calls the
 * gate refused, and its manage_skill calls, which count as saves once their
 * results show they worked. Keeps no text.
 */
function foldMessage(review, message) {
	const content = message?.message?.content;
	if (!Array.isArray(content)) return;
	if (message.type === "assistant") {
		// claude prints each content block of a reply as a message of its own, all with the reply's id and usage.
		if (typeof message.message.id === "string") review.replies.set(message.message.id, tokenCounts(message.message.usage));
		for (const block of content) {
			if (block?.type === "server_tool_use" && block.name === "advisor") review.advisorCalls++;
			if (block?.type !== "tool_use") continue;
			if (!ALLOWED_TOOLS.includes(block.name)) {
				review.refusedCalls++;
				if (typeof block.name === "string") noteToolName(review.refusedTools, block.name);
			} else if (block.name === MANAGE_SKILL_TOOL) {
				const save = requestedSave(block.input);
				if (save) review.pendingSaves.set(block.id, save);
			}
		}
	} else if (message.type === "user") {
		for (const block of content) {
			const save = block?.type === "tool_result" ? review.pendingSaves.get(block.tool_use_id) : undefined;
			if (!save) continue;
			review.pendingSaves.delete(block.tool_use_id);
			if (block.is_error !== true) review.saves.push(save);
		}
	}
}

/** Adds `name`, clipped, to a review's set of tool names to log, unless the set already holds MAX_LOGGED_TOOL_NAMES. */
export function noteToolName(names, name) {
	if (names.size < MAX_LOGGED_TOOL_NAMES) names.add(clip(name, MAX_LOGGED_TOOL_NAME_CHARS));
}

function toolCalls(review) {
	return { advisorCalls: review.advisorCalls, refusedCalls: review.refusedCalls, refusedTools: [...review.refusedTools] };
}

function tokenCounts(usage) {
	return {
		inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
		cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
		outputTokens: usage?.output_tokens ?? 0,
	};
}

function summedTokens(replies) {
	const sum = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
	for (const counts of replies.values()) {
		for (const key of Object.keys(sum)) sum[key] += counts[key];
	}
	return sum;
}

function resultRecord(result, sessionCost, review) {
	const record = {
		outcome: result.is_error ? "error" : "ok",
		turns: result.num_turns,
		...forkCost(result, sessionCost),
		...tokenCounts(result.usage),
		...toolCalls(review),
	};
	if (result.is_error) record.error = clip(errorText(result), MAX_ERROR_CHARS);
	return record;
}

const NO_SESSION_COST = { totalCostUSD: 0, modelUsage: {} };

/**
 * The session's last cost-state entry in its transcript. Claude Code 2.1.325
 * restores a resumed session's cost counters from it, so the totals it
 * reports for the fork include it.
 *
 * @returns {Promise<{totalCostUSD?: unknown, modelUsage?: unknown} | undefined>} undefined when the transcript cannot be read.
 */
async function sessionCostState(transcriptPath, sessionId) {
	let state = NO_SESSION_COST;
	try {
		const { size } = await fs.stat(transcriptPath);
		await readLines(transcriptPath, 0, size, (line) => {
			// Parsing only the few lines that can be cost-state entries keeps a long transcript quick to read.
			if (!line.includes("cost-state")) return;
			const value = parseLine(line);
			if (value?.type === "cost-state" && value.sessionId === sessionId) state = value;
		});
	} catch (error) {
		// Only a failure to read the transcript; a bug should surface as the capture's error.
		if (typeof error.code !== "string") throw error;
		return undefined;
	}
	return state;
}

/**
 * The fork's own cost: claude's total less the session's cost-state entry,
 * when the fork's per-model totals show that it counted on from that entry.
 * A total that cannot be checked is logged as reportedCostUsd, never as the cost.
 */
function forkCost(result, sessionCost) {
	const total = result.total_cost_usd;
	if (typeof total !== "number") return {};
	const counted = sessionCost?.totalCostUSD;
	if (counted === 0) return { costUsd: total };
	if (Number.isFinite(counted) && counted > 0 && countedOnFrom(result.modelUsage, sessionCost.modelUsage)) {
		return { costUsd: Math.round((total - counted) * 1e8) / 1e8, sessionCostUsd: counted };
	}
	return { reportedCostUsd: total };
}

function countedOnFrom(totals, recorded) {
	const models = Object.entries(recorded ?? {});
	return models.length > 0 && models.every(([model, usage]) => (totals?.[model]?.costUSD ?? 0) >= (usage?.costUSD ?? 0));
}

function errorText(result) {
	if (typeof result.result === "string" && result.result) return result.result;
	if (Array.isArray(result.errors) && result.errors.length > 0) return result.errors.join("; ");
	return result.subtype ?? "unknown error";
}
