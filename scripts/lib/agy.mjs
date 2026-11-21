// Antigravity CLI support: reviews the turn a Stop hook queued. A fresh headless
// `agy -p` runs the review in a conversation store of its own, where the
// plugin's review agent lets the model call manage_skill and nothing else. The
// stream agy prints is watched, and the review's conversation is deleted
// afterwards, since it holds an excerpt of the user's work.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REVIEW_STORE_NAME, removeConversation, reviewStoreDir, sweepStore } from "./agy-store.mjs";
import { createStreamAnalyzer } from "./agy-stream.mjs";
import { renderTurn } from "./agy-transcript.mjs";
import { boundedSink, forkEnvironment, isDirectory, isFile, skillChanges } from "./capture.mjs";
import { dataDir, skillsDir } from "./config.mjs";
import { lineSplitter, parseLine } from "./jsonl.mjs";
import { captureNudge, learnedSkillLines } from "./prompts.mjs";
import { learnedSkills } from "./skills.mjs";
import { isValidSessionId } from "./state.mjs";
import { clip } from "./transcript.mjs";

/** The agent file `agents/auto-learn-review.md` defines under this name. */
export const REVIEW_AGENT = "auto-learn-review";
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 500;
/** What agy sets for the hooks and servers of a plugin; the review is a session of its own. */
const HOOK_VARIABLES = ["ANTIGRAVITY_CONVERSATION_ID", "PLUGIN_DATA", "PLUGIN_ROOT"];
/**
 * The prompt arrives on stdin as stream-json, which is how agy takes a prompt
 * of this size; --print-timeout is agy's own limit, inside the outer one. The
 * flags were checked with agy 1.5.14.
 */
const REVIEW_ARGS = [
	"-p",
	"",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--agent",
	REVIEW_AGENT,
	"--print-timeout",
	"240s",
	"--settings",
	'{"toolPermission":"always-proceed"}',
	"--disable-slash-commands",
	`--app_data_dir=${REVIEW_STORE_NAME}`,
];

/** The review's environment: the session's, less what agy and the agents tell a plugin about the session, plus the capture guard and the session's project folder. */
export function agyReviewEnvironment(env, projectDir) {
	const result = forkEnvironment(env);
	for (const key of HOOK_VARIABLES) delete result[key];
	return { ...result, AUTO_LEARN_PROJECT_DIR: projectDir };
}

/**
 * Captures one queued agy turn: renders the turn's excerpt, has `agy -p` review
 * it, then removes the review's conversation from the review store. The
 * returned record holds no transcript text, so it is safe to log.
 */
export async function captureAgyTurn(job, { env = process.env, signal } = {}) {
	if (!isWellFormed(job)) return { outcome: "skipped", reason: "malformed job" };
	if (signal?.aborted) return { outcome: "aborted", reason: String(signal.reason) };
	if (!(await isFile(job.transcriptPath))) return { outcome: "skipped", reason: "the conversation's transcript is gone" };
	if (!(await isDirectory(job.projectDir))) return { outcome: "skipped", reason: "the session's project directory is gone" };

	const started = performance.now();
	// agy keeps its stores under the home it finds in its environment, which is the one it gets from `env`.
	const store = reviewStoreDir(env.HOME || os.homedir());
	let record;
	let conversationId;
	let sweepFailure;
	try {
		const excerpt = await renderTurn(job.transcriptPath, job.start, job.end);
		if (excerpt.trim() === "") return { outcome: "skipped", reason: "the turn is no longer in the transcript" };
		const skills = await learnedSkills(skillsDir(env, "agy"));
		const workspace = path.join(dataDir(env, "agy"), "review-workspace");
		await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
		sweepFailure = await sweepStore(store);
		const review = await runAgyReview({ prompt: reviewPrompt(excerpt, skills), cwd: workspace, env: agyReviewEnvironment(env, job.projectDir), signal });
		conversationId = review.summary.conversationId;
		record = recordOf(review);
	} catch (error) {
		record = { outcome: "error", error: clip(error.message, MAX_ERROR_CHARS) };
	}
	const removeFailure = conversationId === undefined ? undefined : await removeConversation(store, conversationId);
	const cleanupError = removeFailure ?? sweepFailure;
	const durationMs = Math.round(performance.now() - started);
	return { ...record, ...(cleanupError ? { cleanupError } : {}), durationMs };
}

function isWellFormed(job) {
	return (
		isValidSessionId(job?.sessionId) &&
		typeof job.transcriptPath === "string" &&
		path.isAbsolute(job.transcriptPath) &&
		Number.isSafeInteger(job.start) &&
		Number.isSafeInteger(job.end) &&
		job.start >= 0 &&
		job.start <= job.end &&
		typeof job.projectDir === "string" &&
		job.projectDir !== ""
	);
}

/**
 * The review's prompt: a first line that names it, the excerpt between two
 * marker lines with a nonce nothing in the excerpt could have known, then the
 * request, which names the nonce, so that a forged marker in the excerpt is
 * recognisable, refers to the excerpt as "above" and lists the skills saved so far.
 */
function reviewPrompt(excerpt, skills) {
	const nonce = randomBytes(8).toString("hex");
	const request = captureNudge("manage_skill", "agy", { skills: learnedSkillLines(skills) || "none yet", nonce });
	return ["[auto-learn review]", "", `BEGIN EXCERPT ${nonce}`, excerpt, `END EXCERPT ${nonce}`, "", request].join("\n");
}

/** What the log keeps of a review: how it ended, what it saved, what it used. Names and counts only. */
function recordOf({ outcome, reason, error, summary }) {
	const record = {
		outcome,
		reason,
		error,
		finishedReason: summary.finishedReason,
		deniedActions: summary.deniedActions,
		skillCalls: summary.skillCalls,
		otherToolCalls: summary.otherToolCalls,
		otherTools: summary.otherTools,
		stoppedTool: summary.stoppedTool,
		inputTokens: summary.inputTokens,
		cacheReadTokens: summary.cacheReadTokens,
		outputTokens: summary.outputTokens,
		...skillChanges(summary.saves),
	};
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Runs the review: `agy -p` reads the prompt from stdin and prints its steps as
 * stream-json. It runs in a process group of its own, which is killed with it,
 * under the plugin's review agent, so the model is offered manage_skill only; the
 * stream is watched, and the review is stopped at the first call of any other
 * tool. A failure comes back as the outcome rather than an exception, so one bad
 * review never stops the queue. A save counts only from the stream's own record
 * of a call that worked, in a run that ended with the status SUCCESS and no
 * denied actions: the exit status alone proves nothing.
 *
 * @returns {Promise<{outcome: "ok" | "error" | "timeout" | "aborted" | "stopped", reason?: string, error?: string, summary: import("./agy-stream.mjs").StreamSummary}>}
 */
export function runAgyReview({ prompt, cwd, env, signal, timeoutMs = CAPTURE_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS }) {
	return new Promise((resolve) => {
		const child = spawn("agy", REVIEW_ARGS, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const analyzer = createStreamAnalyzer();
		child.stdout.on(
			"data",
			lineSplitter(MAX_STDOUT_LINE_BYTES, (line) => {
				if (analyzer.accept(parseLine(line))) stopChild({ outcome: "stopped", reason: "the review called a tool other than manage_skill" });
			}),
		);
		const stderr = boundedSink(child.stderr, MAX_STDERR_BYTES);
		let stopped;
		let killTimer;
		let settled = false;
		// `record` is what the review reports once the stopped child has exited.
		const stopChild = (record) => {
			if (stopped) return;
			stopped = record;
			killGroup(child, "SIGTERM");
			killTimer = setTimeout(() => killGroup(child, "SIGKILL"), killGraceMs);
		};
		const timer = setTimeout(() => stopChild({ outcome: "timeout" }), timeoutMs);
		const onAbort = () => stopChild({ outcome: "aborted", reason: String(signal.reason) });
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (record, summary = analyzer.finish()) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...record, summary });
		};
		child.once("error", (error) => finish({ outcome: "error", error: error.code === "ENOENT" ? "the agy CLI was not found on PATH" : error.message }));
		child.once("close", (code, exitSignal) => {
			// A stopped review leaves nothing of its process group running, whether or not its main process obeyed.
			if (stopped) killGroup(child, "SIGKILL");
			const summary = analyzer.finish();
			finish(endOf(summary, stopped, code ?? exitSignal, stderr), summary);
		});
		// agy may exit before reading the whole prompt; its exit status tells why.
		child.stdin.on("error", () => {});
		child.stdin.end(`${JSON.stringify({ event: "user", message: { content: [{ type: "text", text: prompt }] } })}\n`);
	});
}

/**
 * How the review ended: a successful result it printed, else the reason it was
 * stopped (an error result printed on the way out of a stopped review says
 * nothing about it), else the error result it printed, else what the process did.
 */
function endOf(summary, stopped, exit, stderr) {
	const { status, deniedActions } = summary;
	if (status === "SUCCESS") {
		if (deniedActions === 0) return { outcome: "ok" };
		return { outcome: "error", error: `agy denied ${deniedActions} ${deniedActions === 1 ? "action" : "actions"}` };
	}
	if (stopped) return stopped;
	if (status !== undefined) return { outcome: "error", error: summary.error ?? `agy ended with the status ${status}` };
	// stderr only: stdout holds the review's own text, which the log must not.
	const detail = stderr().trim().slice(-MAX_ERROR_CHARS) || "no error output";
	return { outcome: "error", error: `agy ended without a result (exit ${exit}): ${detail}` };
}

function killGroup(child, signal) {
	try {
		process.kill(-child.pid, signal);
	} catch {
		// shortcut: no such group (it is gone, or the platform has none, as on Windows); only the child gets the signal there, and a grandchild outlives it.
		child.kill(signal);
	}
}
