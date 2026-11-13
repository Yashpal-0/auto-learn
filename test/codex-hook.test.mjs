import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "../scripts/lib/hook.mjs";
import { manageSkill } from "../scripts/lib/skills.mjs";
import { readSessionState, takeJob } from "../scripts/lib/state.mjs";
import { codexTurn, rollout, tempDir, toJsonl } from "./helpers.mjs";

const HOOK_SCRIPT = new URL("../scripts/hook.mjs", import.meta.url).pathname;

/** A Codex session: the hook runs with --host=codex and reads the session's rollout. */
async function codexSession(t, extraEnv = {}) {
	const root = await tempDir(t);
	const env = {
		CLAUDE_PLUGIN_DATA: path.join(root, "data"),
		AUTO_LEARN_SKILLS_DIR: path.join(root, "skills"),
		CLAUDE_CONFIG_DIR: path.join(root, "config"),
		...extraEnv,
	};
	const transcriptPath = path.join(root, "rollout.jsonl");
	const workers = [];
	const run = (event, input = {}) =>
		runHook(
			event,
			{ session_id: "s1", transcript_path: transcriptPath, cwd: "/work/project", model: "gpt-test", permission_mode: "default", ...input },
			{ env, spawnWorker: async (sessionId) => workers.push(sessionId), host: "codex" },
		);
	const append = (records) => fs.appendFile(transcriptPath, toJsonl(records));
	const size = async () => (await fs.stat(transcriptPath)).size;
	const state = () => readSessionState(env.CLAUDE_PLUGIN_DATA, "s1");
	const log = async () =>
		(await fs.readFile(path.join(env.CLAUDE_PLUGIN_DATA, "auto-learn.log"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const skips = async () => (await log()).map(({ event, reason, toolCalls }) => [event, reason, toolCalls]);
	return { root, env, dataDir: env.CLAUDE_PLUGIN_DATA, transcriptPath, workers, run, append, size, state, skips };
}

test("Codex session start adds the Codex guidance and the learned skills", async (t) => {
	const s = await codexSession(t);
	await manageSkill({ action: "create", name: "deploy-docs", description: "Use when publishing the docs", body: "1. Run it." }, { skillsDir: s.env.AUTO_LEARN_SKILLS_DIR });
	// Claude Code's settings hide skills from Claude Code only.
	await fs.mkdir(s.env.CLAUDE_CONFIG_DIR, { recursive: true });
	await fs.writeFile(path.join(s.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ skillOverrides: { "deploy-docs": "off" } }));
	await s.append([rollout.meta()]);
	const output = await s.run("session-start", { source: "resume" });
	const context = output.hookSpecificOutput.additionalContext;
	assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
	assert.match(context, /Codex offers/);
	assert.doesNotMatch(context, /Claude/);
	assert.match(context, /\n## Learned skills\n[\s\S]*\n- deploy-docs: Use when publishing the docs$/);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 0 });
});

test("a Codex session without a rollout yet starts its first turn at the beginning", async (t) => {
	const s = await codexSession(t);
	await s.run("session-start", { source: "startup", transcript_path: null });
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });
});

test("a Codex turn with enough tool calls queues a capture that names the turn, its settings and the project", async (t) => {
	const s = await codexSession(t);
	await s.append([rollout.meta(), ...codexTurn("t0", 9), rollout.complete("t0")]);
	await s.run("session-start", { source: "resume" });
	await s.append(codexTurn("t1", 5, { model: "gpt-test-2", effort: "xhigh" }));
	await s.run("stop", { turn_id: "t1", stop_hook_active: false, last_assistant_message: "Done." });

	assert.deepEqual(s.workers, ["s1"]);
	assert.deepEqual(await takeJob(s.dataDir, "s1"), {
		host: "codex",
		sessionId: "s1",
		transcriptPath: s.transcriptPath,
		end: await s.size(),
		turnId: "t1",
		projectDir: "/work/project",
		model: "gpt-test-2",
		effort: "xhigh",
		modelProvider: "openai",
	});
	assert.deepEqual(await s.skips(), [["queued", undefined, 5]]);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 5 });
});

test("short turns, plan mode and unattended Codex sessions are not captured", async (t) => {
	const s = await codexSession(t);
	await s.append([rollout.meta()]);
	await s.run("session-start", { source: "startup" });
	await s.append(codexTurn("t1", 4));
	await s.run("stop", { turn_id: "t1" });
	await s.append([rollout.complete("t1"), ...codexTurn("t2", 5, { mode: "plan" })]);
	await s.run("stop", { turn_id: "t2" });

	const unattended = [];
	for (const source of ["exec", "mcp", { subagent: { other: "guardian" } }]) {
		const other = await codexSession(t);
		await other.append([rollout.meta(source), ...codexTurn("t1", 5)]);
		await other.run("stop", { turn_id: "t1" });
		unattended.push(...(await other.skips()), ...other.workers);
	}

	assert.deepEqual(s.workers, []);
	assert.deepEqual(await s.skips(), [
		["skip", "fewer than 5 tool calls", 4],
		["skip", "plan mode", 5],
	]);
	assert.deepEqual(unattended, Array(3).fill(["skip", "unattended session", 5]));
});

test("a Codex turn that a Stop hook continues is counted whole at each stop", async (t) => {
	const s = await codexSession(t);
	await s.append([rollout.meta()]);
	await s.run("session-start", { source: "startup" });
	await s.append(codexTurn("t1", 3));
	await s.run("stop", { turn_id: "t1" });
	// A Stop hook continued the turn under the same turn_id, and it ran three more commands.
	await s.append([1, 2, 3].map((i) => rollout.item("t1", "CommandExecution", `more-${i}`)));
	await s.run("stop", { turn_id: "t1", stop_hook_active: true });
	assert.deepEqual(s.workers, ["s1"]);
	assert.deepEqual(await s.skips(), [
		["skip", "fewer than 5 tool calls", 3],
		["queued", undefined, 6],
	]);
});

test("without saved state, a Codex stop still finds its turn", async (t) => {
	const s = await codexSession(t);
	await s.append([rollout.meta(), ...codexTurn("t1", 6)]);
	await s.run("stop", { turn_id: "t1" });
	assert.deepEqual(s.workers, ["s1"]);
});

test("the options decide whether and when a Codex turn is captured", async (t) => {
	const off = await codexSession(t, { CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "false" });
	await off.append([rollout.meta(), ...codexTurn("t1", 9)]);
	await off.run("stop", { turn_id: "t1" });
	assert.deepEqual(off.workers, []);
	assert.deepEqual(await off.state(), { offset: await off.size(), toolCalls: 9 });

	const eager = await codexSession(t, { CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "1" });
	await eager.append([rollout.meta(), ...codexTurn("t1", 1)]);
	await eager.run("stop", { turn_id: "t1" });
	assert.deepEqual(eager.workers, ["s1"]);
});

test("an ephemeral Codex session is ignored at stop, and a stop without a turn_id is an error", async (t) => {
	const s = await codexSession(t);
	await s.run("stop", { transcript_path: null, turn_id: "t1" });
	assert.equal(await s.state(), undefined);
	assert.deepEqual(s.workers, []);
	await s.append([rollout.meta(), ...codexTurn("t1", 5)]);
	await assert.rejects(s.run("stop"), /turn_id/);
});

test("the hook script serves Codex with --host=codex and refuses other arguments", async (t) => {
	const s = await codexSession(t);
	const run = (args, input) =>
		new Promise((resolve) => {
			const child = execFile(process.execPath, [HOOK_SCRIPT, ...args], { env: { ...process.env, ...s.env } }, (error, stdout, stderr) =>
				resolve({ code: error ? error.code : 0, stdout, stderr }),
			);
			child.stdin.end(input);
		});
	const input = JSON.stringify({ session_id: "s1", transcript_path: null, source: "startup", cwd: "/work/project" });
	const started = await run(["session-start", "--host=codex"], input);
	assert.equal(started.code, 0, started.stderr);
	assert.match(JSON.parse(started.stdout).hookSpecificOutput.additionalContext, /Codex offers/);

	const unknown = await run(["session-start", "--host=other"], input);
	assert.equal(unknown.code, 1);
	assert.equal(unknown.stdout, "");
	assert.match(unknown.stderr, /^auto-learn: Unknown arguments \["--host=other"\]/);
});
