import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parseHost } from "../scripts/lib/config.mjs";
import { runHook, workerArguments } from "../scripts/lib/hook.mjs";
import { manageSkill } from "../scripts/lib/skills.mjs";
import { queueCapture, readSessionState, takeJob } from "../scripts/lib/state.mjs";
import { entry, tempDir, toJsonl, turnWithToolCalls } from "./helpers.mjs";

const HOOK_SCRIPT = new URL("../scripts/hook.mjs", import.meta.url).pathname;

async function session(t, extraEnv = {}) {
	const root = await tempDir(t);
	const env = {
		CLAUDE_PLUGIN_DATA: path.join(root, "data"),
		AUTO_LEARN_SKILLS_DIR: path.join(root, "skills"),
		CLAUDE_PROJECT_DIR: path.join(root, "project"),
		CLAUDE_CONFIG_DIR: path.join(root, "config"),
		CLAUDE_CODE_SESSION_ATTENDED: "1",
		...extraEnv,
	};
	const transcriptPath = path.join(root, "session.jsonl");
	const workers = [];
	const run = (event, input = {}) =>
		runHook(
			event,
			{ session_id: "s1", transcript_path: transcriptPath, cwd: "/work/project", permission_mode: "default", ...input },
			{ env, spawnWorker: async (sessionId) => workers.push(sessionId) },
		);
	const append = (entries) => fs.appendFile(transcriptPath, toJsonl(entries));
	const size = async () => (await fs.stat(transcriptPath)).size;
	const state = () => readSessionState(env.CLAUDE_PLUGIN_DATA, "s1");
	const log = async () =>
		(await fs.readFile(path.join(env.CLAUDE_PLUGIN_DATA, "auto-learn.log"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return { root, env, dataDir: env.CLAUDE_PLUGIN_DATA, transcriptPath, workers, run, append, size, state, log };
}

/** The skip reason and tool call count of each logged record. */
const skips = async (s) => (await s.log()).map(({ event, reason, toolCalls }) => [event, reason, toolCalls]);

test("a capture worker is started with the arguments that give back its host, none for Claude Code", () => {
	for (const host of ["claude", "codex", "copilot", "agy"]) {
		const [script, sessionId, ...flags] = workerArguments("s1", host);
		assert.equal(path.basename(script), "capture.mjs");
		assert.equal(sessionId, "s1");
		// capture.mjs reads its host from what follows the session id, as parseHost does.
		assert.equal(parseHost(flags), host);
	}
});

test("session start adds the skill guidance and marks where the next turn begins", async (t) => {
	const s = await session(t);
	await s.append([entry.prompt("an earlier session"), entry.text("reply")]);
	const output = await s.run("session-start", { source: "resume" });
	assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
	assert.match(output.hookSpecificOutput.additionalContext, /manage_skill/);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 0 });
});

/** Saves a learned skill in the session's skill library, as manage_skill does. */
const learn = (s, name, description = `Use for ${name}`) =>
	manageSkill({ action: "create", name, description, body: "1. Run it." }, { skillsDir: s.env.AUTO_LEARN_SKILLS_DIR });

/** The names in the learned-skill listing that session start adds. */
async function listedSkills(s, source = "startup") {
	const context = (await s.run("session-start", { source })).hookSpecificOutput.additionalContext;
	const [, listing = ""] = context.split("## Learned skills");
	return listing.split("\n").flatMap((line) => (line.startsWith("- ") ? [line.slice(2)] : []));
}

test("session start lists the learned skills after the guidance, again after compaction", async (t) => {
	const s = await session(t);
	await learn(s, "deploy-docs", "Use when publishing the docs");
	for (const source of ["startup", "resume", "clear", "compact"]) {
		const context = (await s.run("session-start", { source })).hookSpecificOutput.additionalContext;
		assert.match(context, /manage_skill[\s\S]*\n## Learned skills\n[\s\S]*\n- deploy-docs: Use when publishing the docs$/, source);
	}
});

test("session start without learned skills adds the guidance alone", async (t) => {
	const s = await session(t);
	assert.deepEqual(await listedSkills(s), []);
	const context = (await s.run("session-start", { source: "startup" })).hookSpecificOutput.additionalContext;
	assert.doesNotMatch(context, /Learned skills/);
});

test("session start leaves out the learned skills that the user's settings hide from Claude", async (t) => {
	const s = await session(t);
	for (const name of ["hidden-skill", "name-only-skill", "own-only-skill", "shown-skill", "plain-skill"]) await learn(s, name);
	await fs.mkdir(s.env.CLAUDE_CONFIG_DIR, { recursive: true });
	const skillOverrides = { "hidden-skill": "off", "name-only-skill": "name-only", "own-only-skill": "user-invocable-only", "shown-skill": "on" };
	await fs.writeFile(path.join(s.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ skillOverrides }));
	assert.deepEqual((await listedSkills(s)).map((line) => line.split(":")[0]).sort(), ["plain-skill", "shown-skill"]);
});

test("a settings file that is not valid JSON hides no learned skill", async (t) => {
	const s = await session(t);
	await learn(s, "deploy-docs");
	await fs.mkdir(s.env.CLAUDE_CONFIG_DIR, { recursive: true });
	await fs.writeFile(path.join(s.env.CLAUDE_CONFIG_DIR, "settings.json"), '{"skillOverrides": {');
	assert.deepEqual(await listedSkills(s), ["deploy-docs: Use for deploy-docs"]);
});

test("a new session starts its first turn at the beginning of the transcript", async (t) => {
	const s = await session(t);
	await s.run("session-start", { source: "startup" });
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });
});

test("a turn with enough tool calls queues a capture of that turn and starts the worker", async (t) => {
	const s = await session(t);
	await s.append([entry.prompt("before"), entry.text("reply")]);
	await s.run("session-start", { source: "resume" });
	const start = await s.size();
	await s.append(turnWithToolCalls(5));
	await s.run("stop", { prompt_id: "p1", effort: { level: "high" } });

	assert.deepEqual(s.workers, ["s1"]);
	const end = await s.size();
	assert.deepEqual(await takeJob(s.dataDir, "s1"), {
		sessionId: "s1",
		transcriptPath: s.transcriptPath,
		start,
		end,
		projectDir: s.env.CLAUDE_PROJECT_DIR,
		effort: "high",
	});
	assert.deepEqual(await s.state(), { offset: end, promptId: "p1", toolCalls: 5 });
	const { time, ...queued } = (await s.log()).at(-1);
	assert.deepEqual(queued, { event: "queued", session: "s1", toolCalls: 5 });
	assert.ok(!Number.isNaN(Date.parse(time)));
});

test("each turn gets its own capture, queued in the order the turns ended", async (t) => {
	const s = await session(t);
	await s.run("session-start", { source: "startup" });
	await s.append(turnWithToolCalls(5, "first task"));
	await s.run("stop", { prompt_id: "p1" });
	const middle = await s.size();
	await s.append(turnWithToolCalls(6, "second task"));
	await s.run("stop", { prompt_id: "p2" });
	const first = await takeJob(s.dataDir, "s1");
	const second = await takeJob(s.dataDir, "s1");
	assert.deepEqual(
		[first.start, first.end, second.start, second.end],
		[0, middle, middle, await s.size()],
	);
	assert.equal(second.effort, undefined, "a model without effort levels sends no effort");
	assert.deepEqual(s.workers, ["s1", "s1"]);
});

test("short turns, plan mode and unattended sessions are not captured, and the next turn still starts after them", async (t) => {
	const s = await session(t);
	await s.run("session-start", { source: "startup" });
	await s.append(turnWithToolCalls(4));
	await s.run("stop", { prompt_id: "p1" });
	await s.append(turnWithToolCalls(5));
	await s.run("stop", { prompt_id: "p2", permission_mode: "plan" });
	assert.equal((await s.state()).offset, await s.size());

	const unattended = await session(t, { CLAUDE_CODE_SESSION_ATTENDED: "0" });
	await unattended.run("session-start", { source: "startup" });
	await unattended.append(turnWithToolCalls(5));
	await unattended.run("stop", { prompt_id: "p1" });

	assert.deepEqual([...s.workers, ...unattended.workers], []);
	assert.deepEqual(
		[...(await skips(s)), ...(await skips(unattended))],
		[
			["skip", "fewer than 5 tool calls", 4],
			["skip", "plan mode", 5],
			["skip", "unattended session", 5],
		],
	);
});

test("the tool calls of a turn that a Stop hook continues add up across its stops", async (t) => {
	const s = await session(t);
	await s.run("session-start", { source: "startup" });
	await s.append(turnWithToolCalls(3));
	await s.run("stop", { prompt_id: "p1" });
	// A Stop hook blocked the stop, so the same turn goes on with two more tool calls.
	await s.append([entry.prompt("Stop hook feedback: run the tests", { isMeta: true }), ...turnWithToolCalls(2).slice(1)]);
	await s.run("stop", { prompt_id: "p1" });
	assert.deepEqual(s.workers, ["s1"]);

	// A new prompt starts the count again, and so does a stop that carries no prompt id.
	await s.append(turnWithToolCalls(4, "next task"));
	await s.run("stop", { prompt_id: "p2" });
	await s.append(turnWithToolCalls(1).slice(1));
	await s.run("stop");
	assert.deepEqual(s.workers, ["s1"]);
	assert.deepEqual(await skips(s), [
		["skip", "fewer than 5 tool calls", 3],
		["queued", undefined, 5],
		["skip", "fewer than 5 tool calls", 4],
		["skip", "fewer than 5 tool calls", 1],
	]);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 1 });
});

test("the options decide whether and when a turn is captured", async (t) => {
	const off = await session(t, { CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "false" });
	await off.run("session-start", { source: "startup" });
	await off.append(turnWithToolCalls(9));
	await off.run("stop");
	assert.deepEqual(off.workers, []);
	assert.equal((await off.state()).offset, await off.size());

	const eager = await session(t, { CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "1" });
	await eager.run("session-start", { source: "startup" });
	await eager.append(turnWithToolCalls(1));
	await eager.run("stop");
	assert.deepEqual(eager.workers, ["s1"]);
});

test("a turn that compaction interrupts keeps its start", async (t) => {
	const s = await session(t);
	await s.run("session-start", { source: "startup" });
	await s.append(turnWithToolCalls(3));
	await s.run("session-start", { source: "compact" });
	await s.append([
		entry.prompt("summary", { isCompactSummary: true }),
		entry.toolUse("toolu_4", "Bash", { command: "step 4" }),
		entry.toolResult("toolu_4", "ok 4"),
		entry.toolUse("toolu_5", "Bash", { command: "step 5" }),
		entry.toolResult("toolu_5", "ok 5"),
		entry.text("Done."),
	]);
	await s.run("stop");
	assert.deepEqual(s.workers, ["s1"]);
	assert.equal((await takeJob(s.dataDir, "s1")).start, 0);
});

test("without saved state, the first stop only marks where the next turn begins", async (t) => {
	const s = await session(t);
	await s.append(turnWithToolCalls(8));
	await s.run("stop");
	assert.deepEqual(s.workers, []);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 0 });
});

test("session end forgets the session and drops its queued captures", async (t) => {
	const s = await session(t);
	await s.run("session-start", { source: "startup" });
	await queueCapture(s.dataDir, { sessionId: "s1", transcriptPath: s.transcriptPath, start: 0, end: 0, projectDir: "/p" });
	await s.run("session-end", { reason: "exit" });
	assert.equal(await s.state(), undefined);
	assert.equal(await takeJob(s.dataDir, "s1"), undefined);
});

test("the capture fork's own Claude Code session is ignored", async (t) => {
	const s = await session(t, { AUTO_LEARN_CAPTURE: "1" });
	assert.equal(await s.run("session-start", { source: "startup" }), undefined);
	await s.run("stop");
	await s.run("session-end");
	await assert.rejects(fs.access(s.dataDir));
});

test("bad input is an error that names the problem", async (t) => {
	const s = await session(t);
	await assert.rejects(s.run("session-start", { session_id: "../x" }), /session_id/);
	await assert.rejects(s.run("pre-tool-use"), /Unknown hook event/);
	await assert.rejects(s.run("stop", { transcript_path: undefined }), /transcript_path/);
});

test("the hook script reads its input from stdin and prints the hook output", async (t) => {
	const s = await session(t);
	const run = (event, input) =>
		new Promise((resolve) => {
			const child = execFile(process.execPath, [HOOK_SCRIPT, event], { env: { ...process.env, ...s.env } }, (error, stdout, stderr) =>
				resolve({ code: error ? error.code : 0, stdout, stderr }),
			);
			child.stdin.end(input);
		});
	const started = await run("session-start", JSON.stringify({ session_id: "s1", transcript_path: s.transcriptPath, source: "startup" }));
	assert.equal(started.code, 0, started.stderr);
	assert.equal(JSON.parse(started.stdout).hookSpecificOutput.hookEventName, "SessionStart");

	// Only agy reads {} as "nothing to add": for the other hosts a hook with nothing to add prints nothing.
	const ended = await run("session-end", JSON.stringify({ session_id: "s1" }));
	assert.deepEqual(ended, { code: 0, stdout: "", stderr: "" });

	const broken = await run("stop", "{not json");
	assert.equal(broken.code, 1);
	assert.equal(broken.stdout, "");
	assert.match(broken.stderr, /^auto-learn: The hook input is not valid JSON\.\n$/);
});
