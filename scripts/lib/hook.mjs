// What the plugin does at each Claude Code hook event: add the skill guidance
// at session start, queue a capture after each eligible turn, and forget the
// session when it ends.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dataDir, loadOptions, skillsDir } from "./config.mjs";
import { guidanceText } from "./prompts.mjs";
import { appendLog, forgetSession, isValidSessionId, queueCapture, readSessionState, writeSessionState } from "./state.mjs";
import { countToolCalls, readTranscriptRange } from "./transcript.mjs";

const WORKER_SCRIPT = fileURLToPath(new URL("../capture.mjs", import.meta.url));

/**
 * Handles one hook event and returns the JSON to print, if any.
 *
 * @param {string} event "session-start", "stop" or "session-end".
 * @param {object} input The hook input Claude Code sends on stdin.
 */
export async function runHook(event, input, { env = process.env, spawnWorker = spawnCaptureWorker } = {}) {
	// A capture runs in a fork of the session, which must not be captured in turn.
	if (env.AUTO_LEARN_CAPTURE) return undefined;
	const sessionId = input?.session_id;
	if (!isValidSessionId(sessionId)) throw new Error(`The hook input has no usable session_id: ${JSON.stringify(sessionId)}.`);
	const dir = dataDir(env);
	switch (event) {
		case "session-start":
			return sessionStart(dir, sessionId, input, env);
		case "stop":
			await stop(dir, sessionId, input, env, spawnWorker);
			return undefined;
		case "session-end":
			await forgetSession(dir, sessionId);
			return undefined;
		default:
			throw new Error(`Unknown hook event ${JSON.stringify(event)}: expected session-start, stop or session-end.`);
	}
}

async function sessionStart(dir, sessionId, input, env) {
	// After compaction the session goes on in the same transcript, so the current turn keeps its start.
	if (input.source !== "compact") {
		await writeSessionState(dir, sessionId, { offset: await transcriptSize(transcriptPathOf(input)), toolCalls: 0 });
	}
	return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: guidanceText(skillsDir(env)) } };
}

async function stop(dir, sessionId, input, env, spawnWorker) {
	const transcriptPath = transcriptPathOf(input);
	const end = await transcriptSize(transcriptPath);
	const saved = await readSessionState(dir, sessionId);
	const start = saved !== undefined && saved.offset <= end ? saved.offset : end;
	const { entries, next } = await readTranscriptRange(transcriptPath, start, end);
	const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : undefined;
	// A Stop hook that continues the turn makes it stop again for the same prompt, so its tool calls add up.
	const earlier = promptId !== undefined && saved?.promptId === promptId ? saved.toolCalls : 0;
	const toolCalls = earlier + countToolCalls(entries);
	await writeSessionState(dir, sessionId, { offset: next, ...(promptId ? { promptId } : {}), toolCalls });

	const options = loadOptions(env);
	if (!options.autoCapture) return;
	const skip = (reason) => appendLog(dir, { event: "skip", session: sessionId, reason, toolCalls });
	// claude -p, SDK and background sessions run with no one at the keyboard to learn for.
	if (env.CLAUDE_CODE_SESSION_ATTENDED === "0") return skip("unattended session");
	if (input.permission_mode === "plan") return skip("plan mode");
	if (toolCalls < options.minToolCalls) return skip(`fewer than ${options.minToolCalls} tool calls`);

	const effort = input.effort?.level;
	await queueCapture(dir, {
		sessionId,
		transcriptPath,
		start,
		end: next,
		projectDir: env.CLAUDE_PROJECT_DIR || input.cwd,
		...(typeof effort === "string" ? { effort } : {}),
	});
	await appendLog(dir, { event: "queued", session: sessionId, toolCalls });
	await spawnWorker(sessionId, env);
}

function transcriptPathOf(input) {
	const value = input.transcript_path;
	if (typeof value !== "string" || !value) throw new Error("The hook input has no transcript_path.");
	return value;
}

async function transcriptSize(file) {
	try {
		return (await fs.stat(file)).size;
	} catch (error) {
		if (error.code === "ENOENT") return 0;
		throw error;
	}
}

/** Starts the capture worker in its own process group, so the hook returns at once and the worker outlives it. */
function spawnCaptureWorker(sessionId, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [WORKER_SCRIPT, sessionId], {
			cwd: dataDir(env),
			env,
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
