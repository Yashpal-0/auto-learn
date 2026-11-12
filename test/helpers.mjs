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
