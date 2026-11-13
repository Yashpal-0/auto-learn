import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { captureCodexTurn, codexPluginId, forkConfig, runCodexFork } from "../scripts/lib/codex.mjs";
import { captureNudge } from "../scripts/lib/prompts.mjs";
import { queueCapture, writeSessionState } from "../scripts/lib/state.mjs";
import { codexTurn, rollout, tempDir, toJsonl } from "./helpers.mjs";

const FAKE_CODEX = new URL("./fake-codex.mjs", import.meta.url).pathname;
const PLUGIN_ROOT = new URL("..", import.meta.url).pathname;
const PLUGIN_ID = "auto-learn@auto-learn";
// What Codex adds to the environment of the session's hooks.
const HOOK_ENV = { PLUGIN_ROOT: "/plugin", PLUGIN_DATA: "/plugin-data", CLAUDE_PLUGIN_ROOT: "/plugin", CLAUDE_PLUGIN_DATA: "/plugin-data" };

/**
 * A temporary world: a fake codex on PATH, a skill library, a project, and a
 * rollout that holds `records` up to the job's end, where the Stop hook
 * stopped reading, then `after`.
 */
async function world(t, mode, { records = [rollout.meta(), ...codexTurn("t1", 5)], after = [rollout.complete("t1")] } = {}) {
	const root = await tempDir(t);
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`, { mode: 0o755 });
	const record = path.join(root, "record.json");
	const env = {
		...process.env,
		PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		FAKE_CODEX_MODE: mode,
		FAKE_CODEX_RECORD: record,
		FAKE_CODEX_PLUGIN_ID: PLUGIN_ID,
		CLAUDE_PLUGIN_DATA: path.join(root, "data"),
		AUTO_LEARN_SKILLS_DIR: path.join(root, "skills"),
	};
	await fs.mkdir(env.CLAUDE_PLUGIN_DATA);
	const projectDir = path.join(root, "project");
	await fs.mkdir(projectDir);
	const transcriptPath = path.join(root, "rollout.jsonl");
	await fs.writeFile(transcriptPath, toJsonl(records));
	const end = (await fs.stat(transcriptPath)).size;
	await fs.appendFile(transcriptPath, toJsonl(after));
	const job = { host: "codex", sessionId: "s1", transcriptPath, end, turnId: "t1", projectDir, model: "gpt-test", effort: "high", modelProvider: "openai" };
	const recorded = async () => JSON.parse(await fs.readFile(record, "utf8"));
	return { root, env, job, record, recorded };
}

const fork = (w, options = {}) => runCodexFork({ threadId: "s1", turnId: "t1", cwd: w.job.projectDir, env: w.env, pluginId: PLUGIN_ID, ...options });
/** The params of each request and notification the fake codex received, by method. */
const sent = async (w) => Object.fromEntries((await w.recorded()).received.filter((message) => message.method).map((message) => [message.method, message.params]));

/** Waits for a file that a child process writes; real time, since the child runs on its own clock. */
async function waitForFile(file, timeoutMs = 10_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		try {
			return await fs.access(file);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (performance.now() > deadline) throw new Error(`${file} did not appear within ${timeoutMs} ms`);
		await sleep(20);
	}
}

test("codexPluginId reads the plugin's id from the folders Codex installs it in", () => {
	assert.equal(codexPluginId("/home/u/.codex/plugins/cache/auto-learn/auto-learn/0.2.0"), "auto-learn@auto-learn");
	assert.equal(codexPluginId("/home/u/.codex/plugins/cache/personal/auto-learn/local/"), "auto-learn@personal");
	assert.equal(codexPluginId(PLUGIN_ROOT), undefined, "a checkout is not an installed plugin");
	assert.equal(codexPluginId("/home/u/.codex/cache/auto-learn/auto-learn/0.2.0"), undefined);
	// A dot would split the configuration key that approves manage_skill.
	assert.equal(codexPluginId("/home/u/.codex/plugins/cache/my.market/auto-learn/0.2.0"), undefined);
});

test("the fork's configuration turns off hooks and notify, leaves no approval to automatic review, and approves manage_skill for the plugin alone", () => {
	assert.deepEqual(forkConfig(PLUGIN_ID), {
		"features.hooks": false,
		notify: [],
		approvals_reviewer: "user",
		"plugins.auto-learn@auto-learn.mcp_servers.auto-learn.tools.manage_skill.approval_mode": "approve",
	});
});

test("runCodexFork forks the session after the turn into an ephemeral read-only thread and asks it for a review", async (t) => {
	const w = await world(t, "ok");
	const env = { ...w.env, ...HOOK_ENV, CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "true" };
	const record = await fork(w, { env, model: "gpt-test", effort: "high", modelProvider: "openai" });
	assert.deepEqual(record, { outcome: "ok", skillCalls: 1, otherToolCalls: 0, inputTokens: 2700, cacheReadTokens: 2400, outputTokens: 80 });

	const { args, cwd, env: forkEnv } = await w.recorded();
	assert.deepEqual(args, ["app-server"]);
	assert.equal(cwd, w.job.projectDir);
	assert.equal(forkEnv.AUTO_LEARN_CAPTURE, "1");
	for (const key of [...Object.keys(HOOK_ENV), "CLAUDE_PLUGIN_OPTION_AUTOCAPTURE"]) assert.equal(forkEnv[key], undefined, key);

	const params = await sent(w);
	assert.equal(params.initialize.clientInfo.name, "auto-learn");
	assert.ok("initialized" in params, "the client must confirm the handshake");
	assert.deepEqual(params["thread/fork"], {
		threadId: "s1",
		lastTurnId: "t1",
		ephemeral: true,
		excludeTurns: true,
		approvalPolicy: "never",
		sandbox: "read-only",
		cwd: w.job.projectDir,
		config: forkConfig(PLUGIN_ID),
		model: "gpt-test",
		modelProvider: "openai",
	});
	assert.deepEqual(params["turn/start"], {
		threadId: "fork-thread",
		input: [{ type: "text", text: captureNudge("manage_skill", "codex") }],
		effort: "high",
	});
});

test("runCodexFork leaves the model, provider and effort to Codex when the session's are unknown", async (t) => {
	const w = await world(t, "ok");
	await fork(w);
	const params = await sent(w);
	for (const key of ["model", "modelProvider"]) assert.equal(key in params["thread/fork"], false, key);
	assert.equal("effort" in params["turn/start"], false);
});

test("runCodexFork counts the fork's other tool calls apart from manage_skill, and only the fork's", async (t) => {
	const w = await world(t, "tools");
	const { skillCalls, otherToolCalls } = await fork(w);
	assert.deepEqual({ skillCalls, otherToolCalls }, { skillCalls: 1, otherToolCalls: 3 });
});

test("runCodexFork declines a request from the app-server and the review goes on", async (t) => {
	const w = await world(t, "request");
	assert.equal((await fork(w)).outcome, "ok");
	const { requestReply } = await w.recorded();
	assert.equal(requestReply.id, 100);
	assert.equal(requestReply.error.code, -32601);
	assert.match(requestReply.error.message, /item\/commandExecution\/requestApproval/);
});

test("a refused fork, a failed turn, and a failing, missing or hung codex are reported, not thrown", async (t) => {
	assert.deepEqual(await fork(await world(t, "fail")), {
		outcome: "error",
		error: "codex app-server refused thread/fork: no rollout found for thread id s1",
	});

	assert.deepEqual(await fork(await world(t, "turn-fail")), {
		outcome: "error",
		error: "You've hit your usage limit.",
		skillCalls: 1,
		otherToolCalls: 0,
		inputTokens: 2700,
		cacheReadTokens: 2400,
		outputTokens: 80,
	});

	assert.deepEqual(await fork(await world(t, "exit")), {
		outcome: "error",
		error: "codex app-server exited (3) before the review ended: Error loading config.toml: invalid type",
	});

	const missing = await world(t, "ok");
	assert.deepEqual(await fork(missing, { env: { ...missing.env, PATH: missing.root } }), {
		outcome: "error",
		error: "the codex CLI was not found on PATH",
	});

	assert.deepEqual(await fork(await world(t, "hang"), { timeoutMs: 300 }), { outcome: "timeout" });
});

test("runCodexFork stops the fork when aborted, and says why", async (t) => {
	const w = await world(t, "hang");
	const controller = new AbortController();
	const pending = fork(w, { signal: controller.signal, timeoutMs: 30_000 });
	await waitForFile(w.record);
	controller.abort("the session ended");
	assert.deepEqual(await pending, { outcome: "aborted", reason: "the session ended" });

	const early = await world(t, "hang");
	assert.deepEqual(await fork(early, { signal: AbortSignal.abort("the session ended"), timeoutMs: 30_000 }), {
		outcome: "aborted",
		reason: "the session ended",
	});
});

test("captureCodexTurn forks the session once the turn has ended and reports the skills the fork saved", async (t) => {
	const w = await world(t, "create");
	const record = await captureCodexTurn(w.job, { env: w.env, pluginId: PLUGIN_ID });
	assert.equal(record.outcome, "ok", record.error);
	assert.deepEqual([record.created, record.updated, record.deleted], [["fake-skill"], [], []]);
	assert.equal(record.skillCalls, 1);
	assert.ok(Number.isInteger(record.durationMs));
	await fs.access(path.join(w.env.AUTO_LEARN_SKILLS_DIR, "fake-skill", "SKILL.md"));
	const params = (await sent(w))["thread/fork"];
	assert.deepEqual([params.model, params.modelProvider, (await sent(w))["turn/start"].effort], ["gpt-test", "openai", "high"]);
});

test("manage_skill in the fork checks the project of the fork's sandbox for a clashing skill", async (t) => {
	const w = await world(t, "create");
	const projectSkill = path.join(w.job.projectDir, ".agents", "skills", "fake-skill");
	await fs.mkdir(projectSkill, { recursive: true });
	await fs.writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: fake-skill\ndescription: Mine\n---\n\nHands off.\n");
	const record = await captureCodexTurn(w.job, { env: w.env, pluginId: PLUGIN_ID });
	assert.deepEqual(record.created, []);
	const { toolResult } = await w.recorded();
	assert.equal(toolResult.isError, true);
	assert.match(toolResult.content[0].text, /another name/);
});

test("captureCodexTurn skips a malformed job, a reviewed turn, an unknown plugin, an interrupted turn and a gone project, without running codex", async (t) => {
	const w = await world(t, "ok");
	const skip = (job, options = {}) => captureCodexTurn(job, { env: w.env, pluginId: PLUGIN_ID, ...options });
	assert.deepEqual(await skip({ ...w.job, turnId: "" }), { outcome: "skipped", reason: "malformed job" });
	assert.deepEqual(await skip({ ...w.job, sessionId: "../s1" }), { outcome: "skipped", reason: "malformed job" });
	assert.deepEqual(await skip(w.job, { reviewedTurns: new Set(["t1"]) }), { outcome: "skipped", reason: "the turn was already reviewed" });
	assert.deepEqual(await captureCodexTurn(w.job, { env: w.env }), {
		outcome: "skipped",
		reason: "the plugin does not run from a Codex plugin install, or its id holds a dot, so the fork cannot approve manage_skill",
	});
	const interrupted = await world(t, "ok", { after: [rollout.aborted("t1")] });
	assert.deepEqual(await skip(interrupted.job), { outcome: "skipped", reason: "the turn was interrupted" });
	await fs.rm(w.job.projectDir, { recursive: true });
	assert.deepEqual(await skip(w.job), { outcome: "skipped", reason: "the session's project directory is gone" });
	for (const world of [w, interrupted]) await assert.rejects(fs.access(world.record), "codex must not run");
});

test("captureCodexTurn reviews a turn once, though each of its stops queued it", async (t) => {
	const w = await world(t, "ok");
	const reviewedTurns = new Set();
	assert.equal((await captureCodexTurn(w.job, { env: w.env, pluginId: PLUGIN_ID, reviewedTurns })).outcome, "ok");
	assert.deepEqual(await captureCodexTurn(w.job, { env: w.env, pluginId: PLUGIN_ID, reviewedTurns }), {
		outcome: "skipped",
		reason: "the turn was already reviewed",
	});
});

test("captureCodexTurn stops waiting for the turn to end once aborted", async (t) => {
	const w = await world(t, "ok", { after: [] });
	const record = await captureCodexTurn(w.job, { env: w.env, pluginId: PLUGIN_ID, signal: AbortSignal.abort("the session ended") });
	assert.deepEqual(record, { outcome: "aborted", reason: "the session ended" });
});

test("the worker script, installed where Codex installs plugins, captures a queued Codex turn once and logs it", async (t) => {
	// A turn that a Stop hook continued: queued at its first stop and again at its second.
	const w = await world(t, "create", { after: [rollout.item("t1", "CommandExecution", "more"), rollout.complete("t1")] });
	const installed = path.join(w.root, "codex-home", "plugins", "cache", "auto-learn", "auto-learn", "0.2.0");
	for (const part of [".claude-plugin", ".codex-plugin", "codex", "prompts", "scripts"]) {
		await fs.cp(path.join(PLUGIN_ROOT, part), path.join(installed, part), { recursive: true });
	}
	w.env.FAKE_CODEX_PLUGIN_ROOT = installed;
	const dataDir = w.env.CLAUDE_PLUGIN_DATA;
	await writeSessionState(dataDir, "s1", { offset: 0, toolCalls: 0 });
	await queueCapture(dataDir, w.job);
	await queueCapture(dataDir, { ...w.job, end: w.job.end + 1 });

	await new Promise((resolve, reject) =>
		execFile(process.execPath, [path.join(installed, "scripts", "capture.mjs"), "s1"], { env: w.env, cwd: dataDir, timeout: 30_000 }, (error) =>
			error ? reject(error) : resolve(),
		),
	);
	const log = (await fs.readFile(path.join(dataDir, "auto-learn.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(
		log.map(({ event, session, outcome, reason, created }) => ({ event, session, outcome, reason, created })),
		[
			{ event: "capture", session: "s1", outcome: "ok", reason: undefined, created: ["fake-skill"] },
			{ event: "capture", session: "s1", outcome: "skipped", reason: "the turn was already reviewed", created: undefined },
		],
	);
});
