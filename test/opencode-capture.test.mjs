import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { reviewTurn, selectTurn } from "../opencode/capture.mjs";
import { manageSkill } from "../scripts/lib/skills.mjs";
import { completedTurn, deferred, nativeHost, proposal } from "./opencode-helpers.mjs";

test("OpenCode counts tools only in the successfully completed turn identified by the event", () => {
	const history = [...completedTurn(10, "build", "old"), ...completedTurn(5)];
	assert.deepEqual(selectTurn(history, "evt_turn"), { turnID: "msg_turn", toolCalls: 5 });
	assert.equal(selectTurn(history, "evt_old").skip, "the session has moved on");
	assert.equal(selectTurn(completedTurn(5, "plan"), "evt_turn").skip, "plan mode");
	const interrupted = completedTurn();
	interrupted.at(-1).outcome = "interrupted";
	assert.equal(selectTurn(interrupted, "evt_turn").skip, "the turn did not succeed");
	assert.equal(selectTurn([], "evt_turn").skip, "the session has moved on");
});

test("OpenCode does not review synthetic-only work or let a new prompt become part of the finished turn", () => {
	const synthetic = completedTurn();
	synthetic[0].type = "synthetic";
	assert.equal(selectTurn(synthetic, "evt_turn").skip, "no user prompt in the turn");
	const messages = [...completedTurn(), { id: "msg_next", type: "user", text: "Next task" }];
	assert.equal(selectTurn(messages, "evt_turn").skip, "the session has moved on");
});

async function review(t, text, overrides = {}) {
	const host = await nativeHost(t);
	const controller = new AbortController();
	host.ctx.session.generate = async () => ({ text, cost: 0.02, tokens: { input: 20, output: 10, reasoning: 3, cache: { read: 100, write: 0 } } });
	const saveSkill = async (args, _call, signal) => {
		signal.throwIfAborted();
		return manageSkill(args, { skillsDir: host.library, projectDir: host.project, host: "opencode" });
	};
	const result = await reviewTurn(host.ctx, { sessionID: "ses_native" }, { saveSkill, signal: controller.signal, ...overrides });
	return { host, result };
}

test("a transient OpenCode review saves a validated proposal and logs only usage and skill names", async (t) => {
	const { host, result } = await review(t, JSON.stringify(proposal));
	assert.equal(result.outcome, "ok");
	assert.deepEqual(result.created, ["native-build"]);
	assert.equal(result.costUsd, 0.02);
	assert.equal(result.inputTokens, 20);
	assert.equal(result.cacheReadTokens, 100);
	assert.equal(result.outputTokens, 10);
	assert.match(await fs.readFile(path.join(host.library, "native-build", "SKILL.md"), "utf8"), /verified build command/);
	assert.doesNotMatch(JSON.stringify(result), /verified build command|Use when building/);
});

test("a review may save nothing, but malformed, extra-field and destructive proposals are errors", async (t) => {
	const nothing = await review(t, "null");
	assert.equal(nothing.result.outcome, "ok");
	assert.deepEqual(nothing.result.created, []);
	await assert.rejects(fs.access(nothing.host.library));
	for (const text of ["not json", "[]", JSON.stringify({ ...proposal, unexpected: "injected" }), JSON.stringify({ action: "delete", name: "native-build" }), "x".repeat(262145)]) {
		const { host, result } = await review(t, text);
		assert.equal(result.outcome, "error");
		assert.equal(result.error, "invalid review response");
		await assert.rejects(fs.access(host.library));
	}
});

test("a review cannot write detected credentials or expose them through its error log", async (t) => {
	const token = `ghp_${"A1b2C3d4".repeat(5)}`;
	const { host, result } = await review(t, JSON.stringify({ ...proposal, body: `GITHUB_TOKEN=${token}` }));
	assert.equal(result.outcome, "error");
	assert.equal(result.error, "skill proposal refused");
	assert.ok(!JSON.stringify(result).includes(token));
	await assert.rejects(fs.access(host.library));
});

test("a late OpenCode response cannot save after cancellation, and a hung review times out", async (t) => {
	for (const cancel of [true, false]) {
		const host = await nativeHost(t);
		const response = deferred();
		const started = deferred();
		const controller = new AbortController();
		host.ctx.session.generate = () => { started.resolve(); return response.promise; };
		let saved = false;
		const running = reviewTurn(host.ctx, { sessionID: "ses_native" }, {
			signal: controller.signal,
			timeoutMs: cancel ? 1000 : 10,
			saveSkill: async () => { saved = true; },
		});
		await started.promise;
		if (cancel) controller.abort("new prompt");
		assert.equal((await running).outcome, cancel ? "aborted" : "timeout");
		response.resolve({ text: JSON.stringify(proposal) });
		await response.promise;
		assert.equal(saved, false);
	}
});

test("a failed native review request is reported without leaking provider error contents", async (t) => {
	const host = await nativeHost(t);
	host.ctx.session.generate = async () => { throw new Error("sensitive provider detail"); };
	const result = await reviewTurn(host.ctx, { sessionID: "ses_native" }, { saveSkill: async () => assert.fail("must not save") });
	assert.equal(result.outcome, "error");
	assert.equal(result.error, "review request failed");
	assert.doesNotMatch(JSON.stringify(result), /sensitive provider detail/);
});
