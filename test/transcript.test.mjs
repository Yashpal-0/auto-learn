import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { clip, countToolCalls, findForkPoint, readTranscriptRange } from "../scripts/lib/transcript.mjs";
import { entry, linked, tempDir, toJsonl, turnWithToolCalls } from "./helpers.mjs";

async function transcriptFile(t, text) {
	const file = path.join(await tempDir(t), "session.jsonl");
	await fs.writeFile(file, text);
	return file;
}

test("readTranscriptRange returns the conversation entries between two offsets", async (t) => {
	const first = toJsonl([entry.prompt("old turn"), entry.text("old reply")]);
	const second = toJsonl([
		{ type: "attachment", attachment: { type: "hook" } },
		entry.prompt("new turn"),
		entry.toolUse("toolu_side", "Read", {}, { isSidechain: true }),
		entry.text("new reply"),
	]);
	const file = await transcriptFile(t, first + second);
	const size = Buffer.byteLength(first + second);
	const { entries, next } = await readTranscriptRange(file, Buffer.byteLength(first), size);
	assert.deepEqual(
		entries.map((value) => value.type),
		["user", "assistant"],
	);
	assert.equal(entries[0].message.content, "new turn");
	assert.equal(next, size);
});

test("readTranscriptRange leaves a line that is still being written for the next read", async (t) => {
	const whole = toJsonl([entry.prompt("done")]);
	const file = await transcriptFile(t, `${whole}{"type":"assistant","mess`);
	const { entries, next } = await readTranscriptRange(file, 0, (await fs.stat(file)).size);
	assert.equal(entries.length, 1);
	assert.equal(next, Buffer.byteLength(whole));
});

test("readTranscriptRange skips lines that are not JSON, such as a range that starts mid-line", async (t) => {
	const text = toJsonl([entry.prompt("first"), entry.prompt("second")]);
	const file = await transcriptFile(t, text);
	const { entries } = await readTranscriptRange(file, 5, Buffer.byteLength(text));
	assert.deepEqual(
		entries.map((value) => value.message.content),
		["second"],
	);
});

test("readTranscriptRange reads lines that span its read chunks", async (t) => {
	const long = "x".repeat(3 * 1024 * 1024);
	const text = toJsonl([entry.prompt(long), entry.prompt("after")]);
	const file = await transcriptFile(t, text);
	const { entries, next } = await readTranscriptRange(file, 0, Buffer.byteLength(text));
	assert.deepEqual(
		entries.map((value) => value.message.content.length),
		[long.length, 5],
	);
	assert.equal(next, Buffer.byteLength(text));
});

test("readTranscriptRange of an empty range reads nothing", async (t) => {
	const file = await transcriptFile(t, toJsonl([entry.prompt("x")]));
	assert.deepEqual(await readTranscriptRange(file, 7, 7), { entries: [], next: 7 });
});

test("countToolCalls counts each tool call once", () => {
	const entries = turnWithToolCalls(3);
	entries.push(entry.toolUse("toolu_1", "Bash", { command: "step 1" }));
	assert.equal(countToolCalls(entries), 3);
	assert.equal(countToolCalls([entry.prompt("hi"), entry.text("hello")]), 0);
});

/**
 * Writes `before`, the part of the turn the Stop hook saw, and `after`, what
 * Claude Code writes once the Stop hooks have run, then looks for the fork point.
 */
async function forkPointOf(t, before, after, options = {}) {
	const head = toJsonl(before);
	const file = await transcriptFile(t, head + toJsonl(after));
	return findForkPoint(file, { start: 0, end: Buffer.byteLength(head), pollDelay: () => 1, ...options });
}

test("findForkPoint forks at the turn's last entry once its stop summary is written", async (t) => {
	const chain = linked([...turnWithToolCalls(2), entry.summary()]);
	assert.deepEqual(await forkPointOf(t, chain.slice(0, -2), chain.slice(-2)), { uuid: "u6", model: "claude-test-1" });
	// The Stop hook may already see the final reply.
	assert.deepEqual(await forkPointOf(t, chain.slice(0, -1), chain.slice(-1)), { uuid: "u6", model: "claude-test-1" });
});

test("findForkPoint waits for the turn to end", async (t) => {
	const chain = linked([entry.prompt("task"), entry.text("Done."), entry.summary()]);
	const head = toJsonl(chain.slice(0, 1));
	const file = await transcriptFile(t, head);
	let polls = 0;
	const forkPoint = await findForkPoint(file, {
		start: 0,
		end: Buffer.byteLength(head),
		pollDelay: () => {
			// Claude Code finishes the turn while the first wait runs.
			if (polls++ === 0) appendFileSync(file, toJsonl(chain.slice(1)));
			return 1;
		},
	});
	assert.deepEqual(forkPoint, { uuid: "u2", model: "claude-test-1" });
	assert.equal(polls, 1);
});

test("findForkPoint forks after a met or failed goal, so the fork does not chase the goal again", async (t) => {
	for (const status of [{ met: true }, { met: false, failed: true }]) {
		const chain = linked([entry.prompt("task"), entry.text("Done."), entry.attachment({ type: "goal_status", ...status }), entry.summary()]);
		assert.deepEqual(await forkPointOf(t, chain.slice(0, 1), chain.slice(1)), { uuid: "u3", model: "claude-test-1" });
	}
});

test("findForkPoint skips a stop after which the turn goes on", async (t) => {
	const cases = [
		[[entry.prompt("Stop hook feedback: run the tests", { isMeta: true })], "a Stop hook continued the turn"],
		[[entry.attachment({ type: "hook_additional_context", hookEvent: "Stop" })], "a Stop hook continued the turn"],
		[
			[entry.prompt("Goal not met", { isMeta: true }), entry.attachment({ type: "goal_status", met: false })],
			"the goal is not met yet, so the turn goes on",
		],
	];
	for (const [tail, reason] of cases) {
		const chain = linked([entry.prompt("task"), entry.text("Done."), ...tail, entry.summary()]);
		assert.deepEqual(await forkPointOf(t, chain.slice(0, 1), chain.slice(1)), { skip: reason });
	}
});

test("findForkPoint skips a turn without a reply from the model", async (t) => {
	const synthetic = linked([entry.prompt("task"), entry.text("No response requested.", "<synthetic>"), entry.summary()]);
	assert.deepEqual(await forkPointOf(t, synthetic.slice(0, 1), synthetic.slice(1)), {
		skip: "the turn ended without a reply from the model",
	});
	const unanswered = linked([entry.prompt("task"), entry.summary()]);
	assert.deepEqual(await forkPointOf(t, unanswered.slice(0, 1), unanswered.slice(1)), {
		skip: "the turn did not end with a reply from the model",
	});
	const orphan = [entry.summary({ uuid: "s1", parentUuid: "missing" })];
	assert.deepEqual(await forkPointOf(t, [], orphan), { skip: "the turn's last entry is not in the transcript" });
});

test("findForkPoint skips a turn that a new prompt follows before its summary", async (t) => {
	const chain = linked([entry.prompt("task"), entry.text("Done."), entry.prompt("next task"), entry.summary()]);
	assert.deepEqual(await forkPointOf(t, chain.slice(0, 1), chain.slice(1)), { skip: "a new prompt arrived before the turn ended" });
	// A tool result is part of the turn, not a prompt.
	const tools = linked([...turnWithToolCalls(1), entry.summary()]);
	assert.deepEqual(await forkPointOf(t, tools.slice(0, 1), tools.slice(1)), { uuid: "u4", model: "claude-test-1" });
});

test("findForkPoint ignores a subagent's entries", async (t) => {
	const chain = linked([entry.prompt("task"), entry.text("Done.")]);
	const after = [
		chain[1],
		entry.prompt("subagent task", { uuid: "side1", parentUuid: null, isSidechain: true }),
		entry.summary({ uuid: "side2", parentUuid: "side1", isSidechain: true }),
		entry.summary({ uuid: "u3", parentUuid: "u2" }),
	];
	assert.deepEqual(await forkPointOf(t, chain.slice(0, 1), after), { uuid: "u2", model: "claude-test-1" });
});

test("findForkPoint takes the model the session asked for over the one that answered", async (t) => {
	const reply = { ...entry.text("Done.", "claude-test-1"), requestedModel: "claude-test-1[1m]" };
	const chain = linked([entry.prompt("task"), reply, entry.summary()]);
	assert.deepEqual(await forkPointOf(t, chain.slice(0, 1), chain.slice(1)), { uuid: "u2", model: "claude-test-1[1m]" });
});

test("findForkPoint gives up when the turn does not end in time or the wait is aborted", async (t) => {
	const turn = linked([entry.prompt("task")]);
	assert.match((await forkPointOf(t, turn, [], { timeoutMs: 20 })).skip, /^the turn did not end within \d+ s$/);

	const controller = new AbortController();
	const pollDelay = () => {
		controller.abort("the session ended");
		return 60_000;
	};
	assert.deepEqual(await forkPointOf(t, turn, [], { signal: controller.signal, pollDelay }), { skip: "aborted" });
});

test("clip shortens long text without splitting a character", () => {
	assert.equal(clip("short", 10), "short");
	assert.equal(clip("abcdefghij", 4), "abcd… [6 more characters]");
	assert.equal(clip("ab😀cd", 3), "ab… [4 more characters]");
});
