// The capture worker's core: takes a session's queued turns oldest first and,
// once each turn has ended, forks the session there so Claude can save what
// the turn taught as a skill, with every tool but manage_skill refused.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { claudeGlobalConfigFile, skillsDir } from "./config.mjs";
import { captureNudge } from "./prompts.mjs";
import { managedSkillVersions } from "./skills.mjs";
import { acquireLock, hasJob, takeJob } from "./state.mjs";
import { clip, findForkPoint } from "./transcript.mjs";

/** The name Claude Code gives manage_skill: mcp__plugin_<plugin>_<server>__<tool>. */
export const MANAGE_SKILL_TOOL = "mcp__plugin_auto-learn_auto-learn__manage_skill";
// ToolSearch loads manage_skill's schema when Claude Code defers MCP tools.
const ALLOWED_TOOLS = [MANAGE_SKILL_TOOL, "ToolSearch"];
// It is echoed between single quotes, so it must not contain one.
const REFUSAL = "Only manage_skill can run during an automatic skill review; nothing was run.";
/** Settings for the fork: a PreToolUse hook that refuses every other tool, even ones the user's settings allow. */
export const GATE_SETTINGS = JSON.stringify({
	hooks: {
		PreToolUse: [
			{ matcher: `^(?!(${ALLOWED_TOOLS.join("|")})$).*$`, hooks: [{ type: "command", command: `echo '${REFUSAL}' >&2; exit 2` }] },
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
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
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

	const library = skillsDir(env);
	const before = await managedSkillVersions(library);
	const started = performance.now();
	const result = await runFork({
		sessionId: job.sessionId,
		forkAt: forkPoint.uuid,
		model: isSafeArgument(forkPoint.model) ? forkPoint.model : undefined,
		effort: typeof job.effort === "string" && EFFORT_LEVEL.test(job.effort) ? job.effort : undefined,
		cwd: job.projectDir,
		env,
		signal,
	});
	const durationMs = Math.round(performance.now() - started);
	// shortcut: a skill another session changes during the capture is counted as the capture's; read the fork's tool results if that misleads.
	return { ...result, ...changedSkills(before, await managedSkillVersions(library)), durationMs };
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

async function isDirectory(target) {
	try {
		return (await fs.stat(target)).isDirectory();
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
		throw error;
	}
}

function changedSkills(before, after) {
	const created = [];
	const updated = [];
	for (const [name, version] of after) {
		if (!before.has(name)) created.push(name);
		else if (before.get(name) !== version) updated.push(name);
	}
	const deleted = [...before.keys()].filter((name) => !after.has(name));
	return { created, updated, deleted };
}

/**
 * Runs the capture fork: `claude -p` resumes the session up to `forkAt` as a
 * new session that is never saved, and gets the capture request as its next
 * prompt. The fork loads the user's settings, plugins and tools, as the
 * session did, so its request reuses the session's prompt cache; the gate
 * hook refuses every tool but manage_skill and ToolSearch. A failure comes
 * back as the record's outcome rather than an exception, so one bad capture
 * never stops the queue. The flags were verified with Claude Code 2.1.322.
 *
 * @returns {Promise<{outcome: "ok" | "error" | "timeout" | "aborted", turns?: number, costUsd?: number, sessionCostUsd?: number, reportedCostUsd?: number, inputTokens?: number, cacheReadTokens?: number, outputTokens?: number, advisorCalls?: number, refusedCalls?: number, reason?: string, error?: string}>}
 */
export async function runFork({ sessionId, forkAt, model, effort, cwd, env, signal, timeoutMs = CAPTURE_TIMEOUT_MS }) {
	const args = [
		"-p",
		"--resume",
		sessionId,
		"--resume-session-at",
		forkAt,
		"--fork-session",
		"--no-session-persistence",
		"--output-format",
		"json",
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
	// Read before the fork starts, since the fork starts its cost counters from what the file holds then.
	const recorded = await recordedSessionCost(sessionId, env);
	return new Promise((resolve) => {
		const child = spawn("claude", args, { cwd, env: forkEnvironment(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const stdout = boundedSink(child.stdout, MAX_STDOUT_BYTES);
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
			resolve(record);
		};
		child.once("error", (error) =>
			finish({ outcome: "error", error: error.code === "ENOENT" ? "the claude CLI was not found on PATH" : error.message }),
		);
		child.once("close", (code, exitSignal) => finish(stopped ?? resultRecord(stdout(), stderr(), code ?? exitSignal, recorded)));
		// claude may exit before reading the whole request; its exit status tells why.
		child.stdin.on("error", () => {});
		child.stdin.end(captureNudge(MANAGE_SKILL_TOOL));
	});
}

function forkEnvironment(env) {
	const result = {};
	for (const [key, value] of Object.entries(env)) {
		if (!PARENT_SESSION_VARIABLES.has(key) && !key.startsWith("CLAUDE_PLUGIN_OPTION_")) result[key] = value;
	}
	return { ...result, AUTO_LEARN_CAPTURE: "1" };
}

/** Collects up to `limit` bytes of a stream and returns a function that reads them as text. */
function boundedSink(stream, limit) {
	const chunks = [];
	let size = 0;
	stream.on("data", (chunk) => {
		if (size >= limit) return;
		chunks.push(chunk.subarray(0, limit - size));
		size += Math.min(chunk.length, limit - size);
	});
	return () => Buffer.concat(chunks).toString("utf8");
}

const NO_SESSION_COST = { costUsd: 0, modelUsage: {} };

/**
 * What Claude Code recorded for the session when it last exited or switched
 * to another conversation. Claude Code 2.1.322 starts a fork that resumes the
 * session from this record, so the totals it reports for the fork include it.
 *
 * @returns {Promise<{costUsd: number, modelUsage: object} | undefined>} undefined when the record cannot be read.
 */
async function recordedSessionCost(sessionId, env) {
	let config;
	try {
		config = JSON.parse(await fs.readFile(claudeGlobalConfigFile(env), "utf8"));
	} catch (error) {
		return error.code === "ENOENT" ? NO_SESSION_COST : undefined;
	}
	const project = Object.values(config?.projects ?? {}).find((entry) => entry?.lastSessionId === sessionId);
	if (!project?.lastCost) return NO_SESSION_COST;
	const { lastCost, lastModelUsage } = project;
	const isReadable = Number.isFinite(lastCost) && typeof lastModelUsage === "object" && Object.keys(lastModelUsage ?? {}).length > 0;
	return isReadable ? { costUsd: lastCost, modelUsage: lastModelUsage } : undefined;
}

/**
 * The fork's own cost: claude's total less the session's recorded cost, when
 * the fork's per-model totals show that it counted on from that record.
 */
function forkCost(result, recorded) {
	const total = result.total_cost_usd;
	if (typeof total !== "number") return {};
	if (!recorded) return { reportedCostUsd: total };
	if (recorded.costUsd > 0 && countedOnFrom(result.modelUsage, recorded.modelUsage)) {
		return { costUsd: Math.round((total - recorded.costUsd) * 1e8) / 1e8, sessionCostUsd: recorded.costUsd };
	}
	return { costUsd: total };
}

function countedOnFrom(totals, recorded) {
	return Object.entries(recorded).every(([model, usage]) => (totals?.[model]?.costUSD ?? 0) >= (usage?.costUSD ?? 0));
}

function resultRecord(stdout, stderr, exitStatus, recorded) {
	let output;
	try {
		output = JSON.parse(stdout);
	} catch {
		// Handled below with the error output that explains it.
	}
	// With verbose output, claude prints the fork's messages as one array that ends with the result.
	const messages = Array.isArray(output) ? output : [];
	const result = Array.isArray(output) ? output.findLast((message) => message?.type === "result") : output;
	if (result?.type !== "result") {
		// stderr only: stdout may hold the fork's reply, which the log must not.
		const detail = stderr.trim().slice(-MAX_ERROR_CHARS) || "no error output";
		return { outcome: "error", error: `claude's output is not a JSON result (exit ${exitStatus}): ${detail}` };
	}
	const usage = result.usage ?? {};
	const record = {
		outcome: result.is_error ? "error" : "ok",
		turns: result.num_turns,
		...forkCost(result, recorded),
		inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
		cacheReadTokens: usage.cache_read_input_tokens ?? 0,
		outputTokens: usage.output_tokens,
		...forkToolCalls(messages),
	};
	if (result.is_error) record.error = clip(errorText(result), MAX_ERROR_CHARS);
	return record;
}

/** Counts the fork's advisor calls, which run on the server where no hook can refuse them, and its calls the gate refused. */
function forkToolCalls(messages) {
	let advisorCalls = 0;
	let refusedCalls = 0;
	for (const message of messages) {
		const content = message?.type === "assistant" ? message.message?.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "server_tool_use" && block.name === "advisor") advisorCalls++;
			else if (block?.type === "tool_use" && !ALLOWED_TOOLS.includes(block.name)) refusedCalls++;
		}
	}
	return { advisorCalls, refusedCalls };
}

function errorText(result) {
	if (typeof result.result === "string" && result.result) return result.result;
	if (Array.isArray(result.errors) && result.errors.length > 0) return result.errors.join("; ");
	return result.subtype ?? "unknown error";
}
