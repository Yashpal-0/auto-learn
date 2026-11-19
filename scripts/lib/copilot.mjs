// GitHub Copilot support: reads a session's events file for the hooks and,
// once a queued turn has ended, reviews the turn in a copy of the session
// through `copilot -p`, where manage_skill is the only tool the model can see.
// The copy is deleted afterwards; the session itself is only read.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { boundedSink, forkEnvironment, isDirectory, noteToolName, requestedSave, skillChanges } from "./capture.mjs";
import { loadOptions } from "./config.mjs";
import { followLines, parseLine, readLines } from "./jsonl.mjs";
import { captureNudge } from "./prompts.mjs";
import { isValidSessionId } from "./state.mjs";
import { clip } from "./transcript.mjs";

/** The name Copilot gives manage_skill: <server>-<tool>. */
export const MANAGE_SKILL_TOOL = "auto-learn-manage_skill";
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
const STOP_EVENT_TIMEOUT_MS = 10 * 1000;
const STOP_EVENT_POLL_MS = 50;
const TURN_END_TIMEOUT_MS = 10 * 60 * 1000;
const DELETE_TIMEOUT_MS = 30 * 1000;
const KILL_GRACE_MS = 5000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 500;
const NEWLINE = Buffer.from("\n");
/**
 * What Copilot tells its hooks about the session and plugin that ran them, and
 * what VS Code's agent host sets for its own runtime, which would make
 * `copilot` run as Node or approve every tool. The review is a session of its own.
 */
const SESSION_VARIABLES = [
	"AUTO_APPROVAL",
	"COPILOT_AGENT_SESSION_ID",
	"COPILOT_CLI_RUN_AS_NODE",
	"COPILOT_DETACHED_PARENT_ENGAGEMENT_ID",
	"COPILOT_DETACHED_PARENT_SESSION_ID",
	"COPILOT_DETACHED_SESSION",
	"COPILOT_HOOK_DIR",
	"COPILOT_LOADER_PID",
	"COPILOT_PLUGIN_DATA",
	"COPILOT_PLUGIN_ROOT",
	"COPILOT_PROJECT_DIR",
	"COPILOT_SESSION_CWD",
	"COPILOT_TRACEPARENT",
	"COPILOT_TRACESTATE",
	"ELECTRON_RUN_AS_NODE",
	"PLUGIN_ROOT",
];

/** The id of a main agent's tool call, in a tool.execution_start event; a subagent's call carries the call that started it as parentToolCallId. */
const mainToolCall = (event) =>
	event?.type === "tool.execution_start" && typeof event.data?.toolCallId === "string" && !event.data.parentToolCallId ? event.data.toolCallId : undefined;

/** The agent mode of a main agent's model round, in an assistant.turn_start event. */
const mainMode = (event) =>
	event?.type === "assistant.turn_start" && typeof event.data?.agentMode === "string" && !event.data.parentToolCallId ? event.data.agentMode : undefined;

/** Whether `event` is a user.message of the main agent: not a subagent's prompt, whose source starts with "agent-". */
const isMainPrompt = (event) =>
	event?.type === "user.message" && !event.data?.parentToolCallId && !String(event.data?.source ?? "").startsWith("agent-");

/** Whether `event` is a hook.start of an agentStop hook of the main agent, which a subagent's stop is not. */
const isMainStop = (event) => event?.type === "hook.start" && event.data?.hookType === "agentStop" && event.data.input?.agentId === undefined && !event.data.parentToolCallId;

/**
 * Reads a Copilot session's events file from byte `start` up to the hook.start
 * event of the agentStop hook that got `stop` as its input: the main agent's
 * tool calls there and the agent mode of its last model round. Copilot writes
 * events in batches, a moment after they happen, and creates the file with the
 * first batch, so this waits up to `timeoutMs` for the hook.start to be
 * written. Returns the hook invocation's id, or none on a timeout, with the
 * offset just past the last line read.
 *
 * Copilot's fusion models, such as VS Code's Auto, write a turn's tool calls
 * and model rounds only after the turn's stop hooks have run, in a block that
 * ends with session.fusion_completed. `fusion` is the id of the fusion turn
 * that was open at the previous stop and is returned as the one open at this
 * stop, or none; a turn it leaves open has no tool calls to count yet. What
 * was counted before a session.fusion_resolved, before the end of the turn that
 * was open at the previous stop, or before the prompt of a turn that no fusion
 * resolved, belongs to an earlier turn's block, and a fusion that was still
 * open there, such as an interrupted one, is over.
 *
 * @returns {Promise<{next: number, toolCalls: number, mode?: string, stopId?: string, fusion?: string}>}
 */
export async function readCopilotTurn(file, start, stop, { timeoutMs = STOP_EVENT_TIMEOUT_MS, fusion: carried } = {}) {
	const deadline = performance.now() + timeoutMs;
	while (!(await isFile(file))) {
		if (performance.now() >= deadline) return { next: start, toolCalls: 0, mode: undefined, stopId: undefined, fusion: carried };
		await sleep(STOP_EVENT_POLL_MS);
	}
	const calls = new Set();
	let mode;
	let fusion = carried;
	// A session.fusion_resolved comes before the user.message that is its turn's prompt.
	let resolved = false;
	let next = start;
	const stopId = await followLines(
		file,
		start,
		(line) => {
			next += line.length + 1;
			const event = parseLine(line);
			const data = event?.data;
			const call = mainToolCall(event);
			const round = mainMode(event);
			if (call) calls.add(call);
			else if (round) mode = round;
			else if (event?.type === "session.fusion_resolved" && typeof data?.fusionId === "string") {
				calls.clear();
				mode = undefined;
				fusion = data.fusionId;
				resolved = true;
			} else if (isMainPrompt(event)) {
				if (resolved) resolved = false;
				else if (data.delivery === "idle") {
					calls.clear();
					mode = undefined;
					fusion = undefined;
				}
			} else if (event?.type === "session.fusion_completed" && data?.fusionId === fusion) {
				if (fusion === carried) {
					calls.clear();
					mode = undefined;
				}
				fusion = undefined;
			} else if (
				isMainStop(event) &&
				typeof data.hookInvocationId === "string" &&
				data.input?.sessionId === stop.sessionId &&
				data.input?.timestamp === stop.timestamp
			) {
				return data.hookInvocationId;
			}
			return undefined;
		},
		{ timeoutMs: Math.max(0, deadline - performance.now()), pollDelay: () => STOP_EVENT_POLL_MS },
	);
	return { next, toolCalls: calls.size, mode, stopId, fusion };
}

async function isFile(file) {
	try {
		return (await fs.stat(file)).isFile();
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Whether someone is at the keyboard of the Copilot session whose events file
 * is `eventsFile`: a VS Code chat, or the Copilot CLI's interactive UI. The
 * session's workspace.yaml names the client that last opened it, which is
 * github/cli for `copilot -p` as well, so the CLI's UI is told apart by
 * COPILOT_LOADER_PID, which its loader gives the hooks and `copilot -p` does not.
 */
// shortcut: COPILOT_LOADER_PID marks the CLI's interactive UI as of Copilot CLI 1.0.114; if a later CLI drops it, its turns are skipped as "unattended session" and need another signal.
export async function isAttendedSession(eventsFile, env) {
	const client = await lastClient(path.join(path.dirname(eventsFile), "workspace.yaml"));
	return client === "vscode-agent-host" || (client === "github/cli" && Boolean(env.COPILOT_LOADER_PID));
}

/** The last_client_name in a session's workspace.yaml, else its client_name, or undefined without either. */
async function lastClient(file) {
	let text;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	const field = (key) => new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(text)?.[1].replace(/^(["'])(.*)\1$/, "$2");
	return field("last_client_name") || field("client_name");
}

/**
 * Captures one queued Copilot turn: waits until the turn that the agentStop
 * hooks, invocation `job.stopId`, ended has ended, copies the session up to
 * there as a new session, has `copilot -p` review the copy, then deletes it.
 * A fusion turn, which `job.fusion` names, was queued before its tool calls
 * were written, so its eligibility is decided here. The returned record holds
 * no transcript text, so it is safe to log.
 */
export async function captureCopilotTurn(job, { env = process.env, signal } = {}) {
	if (!isWellFormed(job)) return { outcome: "skipped", reason: "malformed job" };
	const turn = await findTurnEnd(job, signal);
	if (signal?.aborted) return { outcome: "aborted", reason: String(signal.reason) };
	if (turn === undefined) return { outcome: "skipped", reason: "the turn did not end within 10 minutes" };
	if (turn.skipped) return { outcome: "skipped", reason: turn.skipped };
	if (job.fusion !== undefined) {
		const { minToolCalls } = loadOptions(env);
		if (turn.mode === "plan" || turn.mode === "autopilot") return { outcome: "skipped", reason: `${turn.mode} mode` };
		if (job.toolCalls + turn.toolCalls < minToolCalls) return { outcome: "skipped", reason: `fewer than ${minToolCalls} tool calls` };
	}
	if (!(await isDirectory(job.projectDir))) return { outcome: "skipped", reason: "the session's project directory is gone" };

	const started = performance.now();
	const forkId = randomUUID();
	// The copy goes next to the session, in the session-state folder of the Copilot that runs the session.
	const forkDir = path.join(path.dirname(path.dirname(job.transcriptPath)), forkId);
	const reviewEnv = copilotForkEnvironment(env);
	let record;
	try {
		const copied = await copySession(job.transcriptPath, turn.lastEvent, forkDir, forkId, job.projectDir);
		const result = await runCopilotFork({ forkId, cwd: job.projectDir, env: reviewEnv, signal });
		const { saves, ...activity } = await readForkActivity(path.join(forkDir, "events.jsonl"), copied, forkId);
		record = { ...result, ...activity, ...skillChanges(saves) };
	} catch (error) {
		record = { outcome: "error", error: clip(error.message, MAX_ERROR_CHARS) };
	}
	const cleanupError = await deleteFork(forkId, forkDir, reviewEnv);
	const durationMs = Math.round(performance.now() - started);
	return { ...record, ...(cleanupError ? { cleanupError } : {}), durationMs };
}

function isWellFormed(job) {
	return (
		isValidSessionId(job?.sessionId) &&
		typeof job.transcriptPath === "string" &&
		path.isAbsolute(job.transcriptPath) &&
		Number.isSafeInteger(job.end) &&
		job.end >= 0 &&
		typeof job.stopId === "string" &&
		job.stopId !== "" &&
		(job.fusion === undefined || (typeof job.fusion === "string" && job.fusion !== "" && Number.isSafeInteger(job.toolCalls) && job.toolCalls >= 0)) &&
		typeof job.projectDir === "string" &&
		job.projectDir !== ""
	);
}

/**
 * Waits until the turn that hook invocation `job.stopId` stopped has ended,
 * after byte `job.end` of the session's events file. An ordinary turn ends
 * with the hook.end of that hook. A fusion turn ends with the
 * session.fusion_completed after it, and the main agent's tool calls and the
 * agent mode of its last model round are counted on the way. Returns the id of
 * the event that ends the turn, or why the turn is not reviewed after all, or
 * undefined when the wait times out or `signal` aborts.
 *
 * @returns {Promise<{lastEvent: string, toolCalls: number, mode?: string} | {skipped: string} | undefined>}
 */
function findTurnEnd(job, signal) {
	const calls = new Set();
	let mode;
	let stopEnded = false;
	return followLines(
		job.transcriptPath,
		job.end,
		(line) => {
			const event = parseLine(line);
			const data = event?.data;
			if (!stopEnded) {
				if (event?.type !== "hook.end" || data?.hookInvocationId !== job.stopId || typeof event.id !== "string") return undefined;
				// A stop hook that blocks makes the turn go on, and the stop that ends it is the one reviewed.
				if (data.output?.decision === "block") return { skipped: "a stop hook continued the turn" };
				if (job.fusion === undefined) return { lastEvent: event.id, toolCalls: 0 };
				stopEnded = true;
				return undefined;
			}
			const call = mainToolCall(event);
			const round = mainMode(event);
			if (call) calls.add(call);
			else if (round) mode = round;
			else if (event?.type === "session.fusion_completed" && data?.fusionId === job.fusion && typeof event.id === "string") return { lastEvent: event.id, toolCalls: calls.size, mode };
			// An interrupted fusion turn is never completed, and a cascade's earlier stops are followed by its last one.
			else if (event?.type === "session.fusion_resolved") return { skipped: "the turn's fusion ended without completing" };
			else if (isMainStop(event)) return { skipped: "a later stop ended the turn" };
			return undefined;
		},
		{ signal, timeoutMs: TURN_END_TIMEOUT_MS },
	);
}

/**
 * Writes the session's events up to and including event `lastEvent` to the new
 * session folder `forkDir`, as session `forkId` in `cwd`, and returns the
 * size of the copied events. Only the copy's session.start changes, to name the
 * new session; the source is only read. Copilot loads such a copy like a
 * session it forked itself (checked with Copilot CLI 1.0.114).
 */
async function copySession(eventsFile, lastEvent, forkDir, forkId, cwd) {
	const lines = [];
	let found = false;
	await readLines(eventsFile, 0, (await fs.stat(eventsFile)).size, (line) => {
		if (found) return;
		if (lines.length > 0) {
			lines.push(Buffer.concat([line, NEWLINE]));
			found = line.includes(lastEvent) && parseLine(line)?.id === lastEvent;
			return;
		}
		const start = parseLine(line);
		if (start?.type !== "session.start" || start.data === null || typeof start.data !== "object") {
			throw new Error("the session's events file does not start with session.start");
		}
		start.data.sessionId = forkId;
		start.data.startTime = new Date().toISOString();
		lines.push(Buffer.from(`${JSON.stringify(start)}\n`));
	});
	if (!found) throw new Error("the end of the reviewed turn is missing from the session's events file");
	const events = Buffer.concat(lines);
	const now = new Date().toISOString();
	const workspace = {
		id: forkId,
		summary_count: 0,
		fork_count: 0,
		cwd,
		client_name: "github/cli",
		last_client_name: "github/cli",
		name: "auto-learn skill review",
		user_named: false,
		created_at: now,
		updated_at: now,
	};
	await fs.mkdir(forkDir, { mode: 0o700 });
	await fs.writeFile(path.join(forkDir, "events.jsonl"), events, { mode: 0o600 });
	// JSON strings are YAML strings too, so no value can break the file.
	await fs.writeFile(path.join(forkDir, "workspace.yaml"), Object.entries(workspace).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join(""), { mode: 0o600 });
	await fs.writeFile(path.join(forkDir, ".workspace-fork.lock"), "", { mode: 0o600 });
	return events.length;
}

/**
 * Runs the review: `copilot -p` resumes session `forkId` with the capture
 * request as its next prompt. --available-tools leaves manage_skill the only
 * tool the model is offered, and --allow-tool lets it run without asking. A
 * failure comes back as the record's outcome rather than an exception, so one
 * bad review never stops the queue. The flags were checked with Copilot CLI 1.0.114.
 *
 * @returns {Promise<{outcome: "ok" | "error" | "timeout" | "aborted", reason?: string, error?: string}>}
 */
export function runCopilotFork({ forkId, cwd, env, signal, timeoutMs = CAPTURE_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS }) {
	const args = [
		"-p",
		captureNudge(MANAGE_SKILL_TOOL, "copilot"),
		"--resume",
		forkId,
		"--mode",
		"interactive",
		"--available-tools",
		`mcp:${MANAGE_SKILL_TOOL}`,
		"--allow-tool",
		"auto-learn(manage_skill)",
		"--no-ask-user",
		"--sync-session=off",
		"--no-auto-update",
	];
	return new Promise((resolve) => {
		const child = spawn("copilot", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		const stderr = boundedSink(child.stderr, MAX_STDERR_BYTES);
		let stopped;
		let killTimer;
		// `record` is what the review reports once the stopped child has exited.
		const stopChild = (record) => {
			if (stopped) return;
			stopped = record;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
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
		child.once("error", (error) => finish({ outcome: "error", error: error.code === "ENOENT" ? "the copilot CLI was not found on PATH" : error.message }));
		child.once("close", (code, exitSignal) => {
			if (stopped) return finish(stopped);
			if (code === 0) return finish({ outcome: "ok" });
			// stderr only: stdout holds the review's reply, which the log must not.
			const detail = stderr().trim().slice(-MAX_ERROR_CHARS) || "no error output";
			finish({ outcome: "error", error: `copilot exited (${code ?? exitSignal}) before the review ended: ${detail}` });
		});
	});
}

/**
 * What the review did, from the events it added to the copy after byte
 * `from`: its manage_skill calls and the saves among them that worked, its
 * other tool calls, which fail since --available-tools hides those tools, and
 * the AI credits and tokens of its own model requests. Keeps no text.
 */
async function readForkActivity(eventsFile, from, forkId) {
	const pending = new Map();
	const saves = [];
	const otherTools = new Set();
	const counts = { skillCalls: 0, otherToolCalls: 0 };
	const usage = { nanoAiu: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
	await readLines(eventsFile, from, (await fs.stat(eventsFile)).size, (line) => {
		const event = parseLine(line);
		const data = event?.data;
		if (event?.type === "tool.execution_start") {
			if (data?.toolName === MANAGE_SKILL_TOOL) {
				counts.skillCalls++;
				pending.set(data.toolCallId, requestedSave(data.arguments));
			} else {
				counts.otherToolCalls++;
				if (typeof data?.toolName === "string") noteToolName(otherTools, data.toolName);
			}
		} else if (event?.type === "tool.execution_complete" && pending.has(data?.toolCallId)) {
			const save = pending.get(data.toolCallId);
			pending.delete(data.toolCallId);
			if (save && data.success === true) saves.push(save);
		} else if (event?.type === "session.usage_record" && data?.usage?.accounting?.sourceSessionId === forkId) {
			usage.nanoAiu += finite(data.usage.copilotUsage?.totalNanoAiu);
			usage.inputTokens += finite(data.usage.inputTokens);
			usage.cacheReadTokens += finite(data.usage.cacheReadTokens);
			usage.outputTokens += finite(data.usage.outputTokens);
		}
	});
	const { nanoAiu, ...tokens } = usage;
	return { ...counts, otherTools: [...otherTools], aiCredits: Math.round(nanoAiu / 1000) / 1e6, ...tokens, saves };
}

function finite(value) {
	return Number.isFinite(value) ? value : 0;
}

/**
 * Deletes the review's session. `copilot --headless` removes its folder and its
 * rows in Copilot's session store; when that fails, the folder is removed
 * here and the rows stay. Returns why the deletion failed, or undefined.
 */
async function deleteFork(forkId, forkDir, env) {
	if (!(await isDirectory(forkDir))) return undefined;
	let failure;
	try {
		await deleteSession(forkId, env);
	} catch (error) {
		await fs.rm(forkDir, { recursive: true, force: true });
		failure = clip(error.message, MAX_ERROR_CHARS);
	}
	// `copilot -p --resume` leaves this lock file behind, and Copilot's own deletion keeps it.
	await fs.rm(path.join(path.dirname(forkDir), ".session-operation-locks", `${forkId}.lock`), { force: true });
	return failure;
}

/** Asks `copilot --headless` to delete session `sessionId`, over JSON-RPC with Content-Length framing. */
function deleteSession(sessionId, env) {
	return new Promise((resolve, reject) => {
		const child = spawn("copilot", ["--headless", "--no-auto-update", "--stdio"], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// The server exits once its stdin closes; one that does not is killed.
			child.stdin.end();
			setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(new Error(`copilot --headless did not delete the review's session within ${DELETE_TIMEOUT_MS / 1000} seconds`)), DELETE_TIMEOUT_MS);
		child.once("error", (error) => finish(error.code === "ENOENT" ? new Error("the copilot CLI was not found on PATH") : error));
		child.once("close", () => finish(new Error("copilot --headless exited before deleting the review's session")));
		child.stdin.on("error", () => {});

		const send = (message) => {
			const body = JSON.stringify({ jsonrpc: "2.0", ...message });
			child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		};
		const onMessage = (message) => {
			if (typeof message?.method === "string") {
				if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `auto-learn does not answer ${message.method}` } });
			} else if (message?.id === 1) {
				if (message.error) finish(new Error(`copilot --headless refused to connect: ${message.error.message}`));
				else send({ id: 2, method: "session.delete", params: { sessionId } });
			} else if (message?.id === 2) {
				finish(message.error ? new Error(`copilot --headless did not delete the review's session: ${message.error.message}`) : undefined);
			}
		};
		let buffer = Buffer.alloc(0);
		child.stdout.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (!settled) {
				const headerEnd = buffer.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;
				const length = Number(/^Content-Length: *(\d+)\r?$/im.exec(buffer.subarray(0, headerEnd).toString("latin1"))?.[1]);
				if (!Number.isSafeInteger(length)) return finish(new Error("copilot --headless sent a message without a Content-Length"));
				const bodyEnd = headerEnd + 4 + length;
				if (buffer.length < bodyEnd) return;
				const message = parseLine(buffer.subarray(headerEnd + 4, bodyEnd));
				buffer = buffer.subarray(bodyEnd);
				onMessage(message);
			}
		});
		send({ id: 1, method: "connect", params: { supportedTaskKinds: ["agent", "client", "shell"] } });
	});
}

/** The review's environment: the session's, less what Copilot and VS Code tell the session's hooks about the session, plugin and runtime. */
function copilotForkEnvironment(env) {
	const result = forkEnvironment(env);
	for (const key of SESSION_VARIABLES) delete result[key];
	return result;
}
