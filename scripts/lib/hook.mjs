// What the plugin does at each Claude Code, Codex or GitHub Copilot hook
// event: add the skill guidance and the learned skills at session start, queue
// a capture after each eligible turn, and forget the session when it ends.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeUserSettingsFile, copilotHome, dataDir, loadOptions, skillsDir } from "./config.mjs";
import { isAttendedSession, readCopilotTurn } from "./copilot.mjs";
import { guidanceText, learnedSkillsText } from "./prompts.mjs";
import { readRolloutTurn, readSessionMeta } from "./rollout.mjs";
import { learnedSkills } from "./skills.mjs";
import { appendLog, forgetSession, isValidSessionId, queueCapture, readSessionState, writeSessionState } from "./state.mjs";
import { countToolCalls, readTranscriptRange } from "./transcript.mjs";

const WORKER_SCRIPT = fileURLToPath(new URL("../capture.mjs", import.meta.url));
/** The Codex session sources with someone at the keyboard: the terminal UI and app-server clients such as the IDE extension. */
const ATTENDED_SOURCES = new Set(["cli", "vscode"]);

/**
 * Handles one hook event and returns the JSON to print, if any.
 *
 * @param {string} event "session-start", "stop" or "session-end".
 * @param {object} input The hook input the agent sends on stdin.
 * @param {{env?: object, spawnWorker?: Function, host?: "claude" | "codex" | "copilot"}} [options]
 */
export async function runHook(event, input, { env = process.env, spawnWorker = spawnCaptureWorker, host = "claude" } = {}) {
	// A capture runs in a fork of the session, which must not be captured in turn.
	if (env.AUTO_LEARN_CAPTURE) return undefined;
	// Copilot's own hook events name their fields in camelCase.
	const idField = host === "copilot" ? "sessionId" : "session_id";
	const sessionId = input?.[idField];
	if (!isValidSessionId(sessionId)) throw new Error(`The hook input has no usable ${idField}: ${JSON.stringify(sessionId)}.`);
	const dir = dataDir(env);
	switch (event) {
		case "session-start":
			return sessionStart(dir, sessionId, input, env, host);
		case "stop":
			await ({ codex: codexStop, copilot: copilotStop }[host] ?? stop)(dir, sessionId, input, env, spawnWorker);
			return undefined;
		case "session-end":
			await forgetSession(dir, sessionId);
			return undefined;
		default:
			throw new Error(`Unknown hook event ${JSON.stringify(event)}: expected session-start, stop or session-end.`);
	}
}

async function sessionStart(dir, sessionId, input, env, host) {
	// After compaction the session goes on in the same transcript, so the current turn keeps its start.
	if (input.source !== "compact") {
		// Codex has no rollout yet for a session that has not started its first turn, nor Copilot an events file.
		const transcriptPath =
			host === "codex" ? input.transcript_path : host === "copilot" ? path.join(copilotHome(env), "session-state", sessionId, "events.jsonl") : transcriptPathOf(input);
		const offset = typeof transcriptPath === "string" && transcriptPath ? await transcriptSize(transcriptPath) : 0;
		await writeSessionState(dir, sessionId, { offset, toolCalls: 0 });
	}
	const additionalContext = await sessionContext(env, host);
	// Copilot adds a sessionStart hook's top-level additionalContext to the session, and ignores hookSpecificOutput.
	return host === "copilot" ? { additionalContext } : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
}

/**
 * The guidance, then the learned skills with their descriptions. Claude Code
 * lists skills by name only once its listing outgrows its budget, starting with
 * the skills used least, which new learned skills are; Codex cuts descriptions
 * short past its budget. Compaction resends that listing, so this runs for
 * every source.
 */
async function sessionContext(env, host) {
	const library = skillsDir(env, host);
	// shortcut: for Codex and Copilot, lists learned skills that their own configuration disables; read it when someone disables one.
	const hidden = host === "claude" ? await hiddenSkillNames(env) : new Set();
	const skills = (await learnedSkills(library)).filter(({ name }) => !hidden.has(name));
	return [guidanceText(library, host), learnedSkillsText(skills, host)].filter(Boolean).join("\n\n");
}

/** The skills the user's settings hide from Claude or list by name only: each skillOverrides entry other than "on". */
// shortcut: reads the user settings only, not project, local, managed or --settings overrides; read those when someone hides learned skills there.
async function hiddenSkillNames(env) {
	let settings;
	try {
		settings = JSON.parse(await fs.readFile(claudeUserSettingsFile(env), "utf8"));
	} catch (error) {
		// Listing a hidden skill does less harm than losing the guidance over a broken settings file.
		if (error.code === "ENOENT" || error instanceof SyntaxError) return new Set();
		throw error;
	}
	const overrides = settings?.skillOverrides;
	if (typeof overrides !== "object" || overrides === null) return new Set();
	return new Set(Object.keys(overrides).filter((name) => overrides[name] !== "on"));
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

/**
 * The Codex Stop hook: counts the turn's tool calls in the rollout and queues
 * a capture of an eligible turn. Codex runs Stop hooks again for a turn that
 * one of them continues, under the same turn_id, so the turn is read whole
 * each time rather than added up across its stops.
 */
async function codexStop(dir, sessionId, input, env, spawnWorker) {
	const transcriptPath = input.transcript_path;
	// An ephemeral session keeps no rollout, so there is nothing to read or fork.
	if (typeof transcriptPath !== "string" || !transcriptPath) return;
	const turnId = input.turn_id;
	if (typeof turnId !== "string" || !turnId) throw new Error("The hook input has no turn_id.");
	const end = await transcriptSize(transcriptPath);
	const saved = await readSessionState(dir, sessionId);
	// The turn is found by its id, so without a saved offset the rollout is read from its start.
	const start = saved !== undefined && saved.offset <= end ? saved.offset : 0;
	const turn = await readRolloutTurn(transcriptPath, start, end, turnId);
	const { toolCalls, settings } = turn;
	await writeSessionState(dir, sessionId, { offset: turn.next, toolCalls });

	const options = loadOptions(env);
	if (!options.autoCapture) return;
	const skip = (reason) => appendLog(dir, { event: "skip", session: sessionId, reason, toolCalls });
	const meta = await readSessionMeta(transcriptPath);
	// codex exec, MCP clients and subagents run with no one at the keyboard to learn for.
	if (!ATTENDED_SOURCES.has(meta?.source)) return skip("unattended session");
	if (settings.mode === "plan") return skip("plan mode");
	if (toolCalls < options.minToolCalls) return skip(`fewer than ${options.minToolCalls} tool calls`);

	await queueCapture(dir, {
		host: "codex",
		sessionId,
		transcriptPath,
		end: turn.next,
		turnId,
		projectDir: input.cwd,
		...(settings.model ? { model: settings.model } : {}),
		...(settings.effort ? { effort: settings.effort } : {}),
		...(meta.modelProvider ? { modelProvider: meta.modelProvider } : {}),
	});
	await appendLog(dir, { event: "queued", session: sessionId, toolCalls });
	await spawnWorker(sessionId, env);
}

/**
 * Copilot's agentStop: counts the main agent's tool calls in the session's
 * events file since the last stop, and queues the turn for review when it
 * made enough of them in the interactive mode with someone at the keyboard.
 * A turn of a fusion model, such as VS Code's Auto, is queued before it is
 * counted, since Copilot writes its tool calls after its stop.
 */
async function copilotStop(dir, sessionId, input, env, spawnWorker) {
	const transcriptPath = input.transcriptPath;
	if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) throw new Error("The hook input has no usable transcriptPath.");
	// A subagent's stop names the subagent as sessionId, with the main agent's events file.
	if (input.agentId !== undefined || path.basename(path.dirname(transcriptPath)) !== sessionId) return;
	const saved = await readSessionState(dir, sessionId);
	const options = loadOptions(env);
	const size = await transcriptSize(transcriptPath);
	if (saved === undefined || saved.offset > size) {
		// Where the turn started is unknown, so it is not reviewed; the next turn starts here.
		await writeSessionState(dir, sessionId, { offset: size, toolCalls: 0 });
		if (options.autoCapture) await appendLog(dir, { event: "skip", session: sessionId, reason: "no saved state for the session", toolCalls: 0 });
		return;
	}
	const turn = await readCopilotTurn(transcriptPath, saved.offset, input, { fusion: saved.fusion });
	const { next, mode, stopId, fusion } = turn;
	// A turn that another plugin's stop hook continues stops again, with stop_hook_active set, so its tool calls add up.
	const toolCalls = (input.stop_hook_active === true ? saved.toolCalls : 0) + turn.toolCalls;
	await writeSessionState(dir, sessionId, { offset: next, toolCalls, ...(fusion ? { fusion } : {}) });

	if (!options.autoCapture) return;
	const skip = (reason) => appendLog(dir, { event: "skip", session: sessionId, reason, toolCalls });
	if (stopId === undefined) return skip("Copilot did not write the stop to the session's events file within 10 seconds");
	if (!(await isAttendedSession(transcriptPath, env))) return skip("unattended session");
	// Autopilot goes on without the user and stops after each step, so its steps are not reviewed.
	if (mode === "plan" || mode === "autopilot") return skip(`${mode} mode`);
	// A fusion turn's tool calls are written after its stop, so the capture worker counts them and applies minToolCalls.
	if (fusion === undefined && toolCalls < options.minToolCalls) return skip(`fewer than ${options.minToolCalls} tool calls`);
	await queueCapture(dir, {
		host: "copilot",
		sessionId,
		transcriptPath,
		end: next,
		stopId,
		...(fusion ? { fusion, toolCalls } : {}),
		projectDir: env.COPILOT_PROJECT_DIR || input.cwd,
	});
	await appendLog(dir, { event: "queued", session: sessionId, toolCalls, ...(fusion ? { fusion: true } : {}) });
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
