import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A fresh directory, removed after the test. */
export async function tempDir(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-learn-test-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

/** Transcript entries shaped like the lines of a Claude Code session JSONL file. */
export const entry = {
	prompt: (text, extra = {}) => ({
		type: "user",
		origin: { kind: "human" },
		cwd: "/work/project",
		gitBranch: "main",
		message: { role: "user", content: text },
		...extra,
	}),
	text: (text, model = "claude-test-1") => ({
		type: "assistant",
		message: { role: "assistant", model, content: [{ type: "text", text }] },
	}),
	thinking: (text) => ({
		type: "assistant",
		message: { role: "assistant", model: "claude-test-1", content: [{ type: "thinking", thinking: text }] },
	}),
	toolUse: (id, name, input, extra = {}) => ({
		type: "assistant",
		message: { role: "assistant", model: "claude-test-1", content: [{ type: "tool_use", id, name, input }] },
		...extra,
	}),
	toolResult: (id, content, isError = false) => ({
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
	}),
	attachment: (attachment) => ({ type: "attachment", attachment }),
	/** The entry Claude Code writes once a turn's Stop hooks have run; its parent is the turn's last entry. */
	summary: (extra = {}) => ({ type: "system", subtype: "stop_hook_summary", ...extra }),
};

/** Gives entries the chain Claude Code writes: a uuid each, and the previous entry as parent. */
export function linked(entries) {
	return entries.map((value, index) => ({ uuid: `u${index + 1}`, parentUuid: index === 0 ? null : `u${index}`, ...value }));
}

/** One turn: a prompt, `count` tool calls each followed by its result, and a closing reply. */
export function turnWithToolCalls(count, prompt = "Set up the dev database") {
	const entries = [entry.prompt(prompt)];
	for (let i = 1; i <= count; i++) {
		entries.push(entry.toolUse(`toolu_${i}`, "Bash", { command: `step ${i}` }), entry.toolResult(`toolu_${i}`, `ok ${i}`));
	}
	entries.push(entry.text("Done: the database is ready."));
	return entries;
}

export function toJsonl(entries) {
	return entries.map((value) => `${JSON.stringify(value)}\n`).join("");
}

/** Records shaped like the lines of a Codex session rollout, as Codex 0.168 writes them. */
export const rollout = {
	meta: (source = "cli", extra = {}) => ({
		type: "session_meta",
		payload: { id: "s1", source, model_provider: "openai", cwd: "/work/project", cli_version: "0.168.0", ...extra },
	}),
	started: (turnId) => ({ type: "event_msg", payload: { type: "task_started", turn_id: turnId, collaboration_mode_kind: "default" } }),
	context: (turnId, { model = "gpt-test", effort = "high", mode = "default" } = {}) => ({
		type: "turn_context",
		payload: { turn_id: turnId, cwd: "/work/project", model, effort, collaboration_mode: { mode, settings: { model } } },
	}),
	item: (turnId, type, id) => ({ type: "event_msg", payload: { type: "item_completed", thread_id: "s1", turn_id: turnId, item: { type, id } } }),
	call: (turnId, callId) => ({
		type: "response_item",
		payload: { type: "function_call", name: "exec", call_id: callId, internal_chat_message_metadata_passthrough: { turn_id: turnId } },
	}),
	complete: (turnId) => ({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }),
	aborted: (turnId) => ({ type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId, reason: "interrupted" } }),
};

/** One Codex turn up to its Stop hook: its start, `count` commands each run through one exec call, and the reply. */
export function codexTurn(turnId, count, settings) {
	const records = [rollout.started(turnId), rollout.context(turnId, settings), rollout.item(turnId, "UserMessage", `${turnId}-prompt`)];
	for (let i = 1; i <= count; i++) {
		records.push(rollout.call(turnId, `${turnId}-call-${i}`), rollout.item(turnId, "CommandExecution", `${turnId}-command-${i}`));
	}
	records.push(rollout.item(turnId, "AgentMessage", `${turnId}-reply`));
	return records;
}

let copilotEventCount = 0;
function copilotEvent(type, data) {
	copilotEventCount++;
	return { type, data, id: `event-${copilotEventCount}`, timestamp: "2026-11-19T10:00:00.000Z", parentId: copilotEventCount === 1 ? null : `event-${copilotEventCount - 1}` };
}

/** Events shaped like the lines of a GitHub Copilot session's events.jsonl, as Copilot CLI 1.0.114 writes them. */
export const copilot = {
	start: (sessionId) =>
		copilotEvent("session.start", { sessionId, version: 1, producer: "copilot-agent", copilotVersion: "1.0.114", startTime: "2026-11-19T10:00:00.000Z", context: { cwd: "/work/project" } }),
	// Copilot delivers the prompt that starts a turn to an idle session; a message sent into a running turn, or a stop hook's reason, is "queued".
	prompt: (content, delivery = "idle") => copilotEvent("user.message", { content, delivery }),
	turnStart: (turnId, agentMode = "interactive") => copilotEvent("assistant.turn_start", { turnId, agentMode }),
	toolStart: (toolCallId, toolName = "bash", extra = {}) => copilotEvent("tool.execution_start", { toolCallId, toolName, arguments: {}, ...extra }),
	toolEnd: (toolCallId, success = true) => copilotEvent("tool.execution_complete", { toolCallId, success }),
	reply: (content) => copilotEvent("assistant.message", { content }),
	turnEnd: (turnId) => copilotEvent("assistant.turn_end", { turnId }),
	hookStart: (hookInvocationId, hookType, input = {}) => copilotEvent("hook.start", { hookInvocationId, hookType, input }),
	hookEnd: (hookInvocationId, hookType, output) => copilotEvent("hook.end", { hookInvocationId, hookType, success: true, ...(output ? { output } : {}) }),
	fusionResolved: (fusionId) => copilotEvent("session.fusion_resolved", { fusionId, turnId: `${fusionId}:turn`, syntheticModel: "hydrafusion-max", policy: "max", pattern: "single" }),
	fusionCommit: (fusionId) => copilotEvent("session.fusion_commit_started", { fusionId, commitId: `${fusionId}:commit`, kind: "text", toolCallId: null }),
	fusionDone: (fusionId) => copilotEvent("session.fusion_completed", { fusionId, commitId: `${fusionId}:commit`, turnId: `${fusionId}:turn`, outcome: "completed" }),
	usage: (sourceSessionId, { nanoAiu, inputTokens, cacheReadTokens, outputTokens }) =>
		copilotEvent("session.usage_record", { usage: { inputTokens, cacheReadTokens, outputTokens, copilotUsage: { totalNanoAiu: nanoAiu }, accounting: { sourceSessionId } } }),
};

/**
 * One main-agent turn of a Copilot session up to its agentStop hooks: a
 * prompt, `count` tool calls in model rounds of one call each, and the start of
 * the last round, which is where the events file ends while the hooks run.
 */
export function copilotTurn(count, { mode = "interactive", prompt = "Set up the dev database" } = {}) {
	const events = [copilot.prompt(prompt)];
	for (let i = 1; i <= count; i++) {
		const id = `${copilotEventCount}-${i}`;
		events.push(copilot.turnStart(String(i), mode), copilot.toolStart(`call-${id}`), copilot.toolEnd(`call-${id}`), copilot.turnEnd(String(i)));
	}
	events.push(copilot.turnStart(String(count + 1), mode));
	return events;
}

/** The timestamp in the input of copilotStopped's agentStop hooks. */
export const COPILOT_STOP_TIME = 1795103691472;

/**
 * The end of a Copilot turn in its events file: the last reply, the start of
 * the main agent's agentStop hooks `hookId` with their input, and their end.
 */
export function copilotStopped(sessionId, { hookId = "stop-1", timestamp = COPILOT_STOP_TIME } = {}) {
	return [
		copilot.reply("Done: the database is ready."),
		copilot.turnEnd("last"),
		copilot.hookStart(hookId, "agentStop", { sessionId, timestamp, cwd: "/work/project", stopReason: "end_turn", stop_hook_active: false }),
		copilot.hookEnd(hookId, "agentStop"),
	];
}

/**
 * One main-agent turn on a Copilot fusion model, such as VS Code's Auto, in
 * the order Copilot writes it (checked with VS Code 1.147's agent host): while
 * the turn's agentStop hooks run, the file holds `before`, where a tool call
 * shows only as its preToolUse and postToolUse hooks. `after` follows them: the
 * block that Copilot commits, with the tool calls and model rounds, ending with
 * session.fusion_completed. An interrupted turn has no end to its block.
 */
export function copilotFusionTurn(fusionId, count, { mode = "interactive", prompt = "Set up the dev database" } = {}) {
	const before = [copilot.fusionResolved(fusionId), copilot.prompt(prompt)];
	const after = [copilot.fusionCommit(fusionId)];
	for (let i = 1; i <= count; i++) {
		const call = `${fusionId}-call-${i}`;
		before.push(copilot.hookStart(`pre-${call}`, "preToolUse"), copilot.hookEnd(`pre-${call}`, "preToolUse"), copilot.hookStart(`post-${call}`, "postToolUse"), copilot.hookEnd(`post-${call}`, "postToolUse"));
		after.push(copilot.turnStart(String(i), mode), copilot.toolStart(call), copilot.toolEnd(call), copilot.turnEnd(String(i)));
	}
	after.push(copilot.turnStart(String(count + 1), mode), copilot.reply("Done: the database is ready."), copilot.turnEnd(String(count + 1)), copilot.fusionDone(fusionId));
	return { before, after };
}
