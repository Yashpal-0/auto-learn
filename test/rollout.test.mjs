import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { findTurnEnd, readRolloutTurn, readSessionMeta } from "../scripts/lib/rollout.mjs";
import { codexTurn, rollout, tempDir, toJsonl } from "./helpers.mjs";

async function rolloutFile(t, records) {
	const file = path.join(await tempDir(t), "rollout.jsonl");
	await fs.writeFile(file, toJsonl(records));
	return file;
}

const size = async (file) => (await fs.stat(file)).size;

test("readSessionMeta reads where the session was started from and its model provider", async (t) => {
	assert.deepEqual(await readSessionMeta(await rolloutFile(t, [rollout.meta("cli"), ...codexTurn("t1", 1)])), {
		source: "cli",
		modelProvider: "openai",
	});
	// A subagent's source is an object, which names no attended client.
	const subagent = rollout.meta({ subagent: { other: "guardian" } }, { model_provider: "" });
	assert.deepEqual(await readSessionMeta(await rolloutFile(t, [subagent])), {});
});

test("readSessionMeta finds nothing without a session_meta first line or a rollout", async (t) => {
	assert.equal(await readSessionMeta(await rolloutFile(t, [...codexTurn("t1", 1), rollout.meta()])), undefined);
	assert.equal(await readSessionMeta(await rolloutFile(t, [])), undefined);
	assert.equal(await readSessionMeta(path.join(await tempDir(t), "missing.jsonl")), undefined);
});

test("readRolloutTurn counts the tool items of its turn once each, and reads the turn's settings", async (t) => {
	const records = [
		rollout.meta(),
		...codexTurn("t1", 7),
		rollout.complete("t1"),
		...codexTurn("t2", 3, { model: "gpt-other", effort: "low", mode: "plan" }),
		rollout.item("t2", "CommandExecution", "t2-command-1"),
		rollout.item("t2", "McpToolCall", "t2-mcp"),
		rollout.item("t2", "Reasoning", "t2-thinking"),
		rollout.item("t2", "FileChange", "t2-patch"),
	];
	const file = await rolloutFile(t, records);
	const end = await size(file);
	assert.deepEqual(await readRolloutTurn(file, 0, end, "t2"), {
		toolCalls: 5,
		settings: { model: "gpt-other", effort: "low", mode: "plan" },
		next: end,
	});
	const first = await readRolloutTurn(file, 0, end, "t1");
	assert.equal(first.toolCalls, 7);
	assert.deepEqual(first.settings, { model: "gpt-test", effort: "high", mode: "default" });
});

test("readRolloutTurn reads the rollout from its start when the turn began before the range", async (t) => {
	const file = await rolloutFile(t, [rollout.meta(), ...codexTurn("t1", 4)]);
	const firstStop = await size(file);
	// A Stop hook continued the turn, which went on to run two more commands.
	await fs.appendFile(file, toJsonl([rollout.item("t1", "CommandExecution", "more-1"), rollout.item("t1", "CommandExecution", "more-2")]));
	const end = await size(file);
	const turn = await readRolloutTurn(file, firstStop, end, "t1");
	assert.equal(turn.toolCalls, 6);
	assert.deepEqual(turn.settings, { model: "gpt-test", effort: "high", mode: "default" });
	assert.equal(turn.next, end);
});

test("readRolloutTurn leaves a line still being written for the next read", async (t) => {
	const file = await rolloutFile(t, [rollout.meta(), ...codexTurn("t1", 2)]);
	const complete = await size(file);
	await fs.appendFile(file, JSON.stringify(rollout.item("t1", "CommandExecution", "partial")).slice(0, 30));
	const turn = await readRolloutTurn(file, 0, await size(file), "t1");
	assert.equal(turn.toolCalls, 2);
	assert.equal(turn.next, complete);
});

test("findTurnEnd waits for the turn's task_complete", async (t) => {
	const file = await rolloutFile(t, [rollout.meta(), ...codexTurn("t1", 1)]);
	const end = await size(file);
	let polls = 0;
	const pollDelay = () => {
		if (polls++ === 0) appendFileSync(file, toJsonl([rollout.item("t1", "AgentMessage", "late"), rollout.complete("t1")]));
		return 1;
	};
	assert.deepEqual(await findTurnEnd(file, { end, turnId: "t1", pollDelay }), { ended: true });
	assert.equal(polls, 1);
});

test("findTurnEnd skips a turn that was interrupted or that a new turn followed before it ended", async (t) => {
	for (const [after, reason] of [
		[[rollout.aborted("t1")], "the turn was interrupted"],
		[[rollout.started("t2"), rollout.complete("t1")], "a new turn started before the turn ended"],
	]) {
		const file = await rolloutFile(t, [rollout.meta(), ...codexTurn("t1", 1)]);
		const end = await size(file);
		await fs.appendFile(file, toJsonl(after));
		assert.deepEqual(await findTurnEnd(file, { end, turnId: "t1" }), { skip: reason });
	}
});

test("findTurnEnd ignores another turn's end and a subagent's records", async (t) => {
	const file = await rolloutFile(t, [rollout.meta(), ...codexTurn("t1", 1)]);
	const end = await size(file);
	await fs.appendFile(file, toJsonl([rollout.complete("t0"), rollout.item("t1", "SubAgentActivity", "a1"), rollout.complete("t1")]));
	assert.deepEqual(await findTurnEnd(file, { end, turnId: "t1" }), { ended: true });
});

test("findTurnEnd gives up when the turn does not end in time or the wait is aborted", async (t) => {
	const file = await rolloutFile(t, [rollout.meta(), ...codexTurn("t1", 1)]);
	const end = await size(file);
	assert.deepEqual(await findTurnEnd(file, { end, turnId: "t1", timeoutMs: 0 }), { skip: "the turn did not end within 0 s" });
	const controller = new AbortController();
	const pollDelay = () => {
		controller.abort("test");
		return 60_000;
	};
	assert.deepEqual(await findTurnEnd(file, { end, turnId: "t1", signal: controller.signal, pollDelay }), { skip: "aborted" });
});
