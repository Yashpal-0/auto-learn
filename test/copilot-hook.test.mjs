import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { readCopilotTurn } from "../scripts/lib/copilot.mjs";
import { runHook } from "../scripts/lib/hook.mjs";
import { manageSkill } from "../scripts/lib/skills.mjs";
import { readSessionState, takeJob, writeSessionState } from "../scripts/lib/state.mjs";
import { COPILOT_STOP_TIME, copilot, copilotFusionTurn, copilotStopped, copilotTurn, tempDir, toJsonl } from "./helpers.mjs";

const HOOK_SCRIPT = new URL("../scripts/hook.mjs", import.meta.url).pathname;
const SESSION = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
/** The events Copilot has written by the time the stop's hooks run: the turn's last reply and the hooks' start. */
const stopping = (options) => copilotStopped(SESSION, options).slice(0, 3);

/**
 * A GitHub Copilot session: the hook runs with --host=copilot and reads the
 * session's events file in COPILOT_HOME, whose workspace.yaml names `client`
 * as the client that last opened it.
 */
async function copilotSession(t, { client = "vscode-agent-host", env: extraEnv = {} } = {}) {
	const root = await tempDir(t);
	const env = {
		COPILOT_HOME: path.join(root, "copilot"),
		CLAUDE_PLUGIN_DATA: path.join(root, "data"),
		CLAUDE_CONFIG_DIR: path.join(root, "config"),
		COPILOT_PROJECT_DIR: "/work/project",
		...extraEnv,
	};
	const sessionDir = path.join(env.COPILOT_HOME, "session-state", SESSION);
	await fs.mkdir(sessionDir, { recursive: true });
	if (client) await fs.writeFile(path.join(sessionDir, "workspace.yaml"), `id: ${SESSION}\ncwd: /work/project\nclient_name: github/cli\nlast_client_name: ${client}\n`);
	const transcriptPath = path.join(sessionDir, "events.jsonl");
	const workers = [];
	const run = (event, input = {}) =>
		runHook(
			event,
			{ sessionId: SESSION, timestamp: COPILOT_STOP_TIME, cwd: "/work/elsewhere", ...(event === "stop" ? { transcriptPath, stopReason: "end_turn", stop_hook_active: false } : {}), ...input },
			{ env, spawnWorker: async (sessionId) => workers.push(sessionId), host: "copilot" },
		);
	const append = (events) => fs.appendFile(transcriptPath, toJsonl(events));
	const size = async () => (await fs.stat(transcriptPath)).size;
	const state = () => readSessionState(env.CLAUDE_PLUGIN_DATA, SESSION);
	const skips = async () =>
		(await fs.readFile(path.join(env.CLAUDE_PLUGIN_DATA, "auto-learn.log"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.map(({ event, reason, toolCalls }) => [event, reason, toolCalls]);
	return { root, env, dataDir: env.CLAUDE_PLUGIN_DATA, transcriptPath, workers, run, append, size, state, skips };
}

test("Copilot session start adds the Copilot guidance and the learned skills as top-level additionalContext", async (t) => {
	const s = await copilotSession(t);
	await manageSkill({ action: "create", name: "deploy-docs", description: "Use when publishing the docs", body: "1. Run it." }, { skillsDir: path.join(s.env.COPILOT_HOME, "skills") });
	// Claude Code's settings hide skills from Claude Code only.
	await fs.mkdir(s.env.CLAUDE_CONFIG_DIR, { recursive: true });
	await fs.writeFile(path.join(s.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ skillOverrides: { "deploy-docs": "off" } }));
	await s.append([copilot.start(SESSION), ...copilotTurn(2), ...copilotStopped(SESSION)]);
	const output = await s.run("session-start", { source: "resume" });
	assert.deepEqual(Object.keys(output), ["additionalContext"]);
	assert.match(output.additionalContext, /GitHub Copilot offers/);
	assert.match(output.additionalContext, /`auto-learn-manage_skill`/);
	assert.doesNotMatch(output.additionalContext, /Claude|Codex/);
	assert.match(output.additionalContext, /\n## Learned skills\n[\s\S]*\n- deploy-docs: Use when publishing the docs$/);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 0 });
});

test("a new Copilot session, which has no events file yet, starts its first turn at the beginning", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start", { source: "new", initialPrompt: "hi" });
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });
});

test("a Copilot turn with enough tool calls queues a capture of the turn up to its stop, in a VS Code chat or the Copilot CLI's interactive UI", async (t) => {
	for (const [client, env] of [
		["vscode-agent-host", {}],
		["github/cli", { COPILOT_LOADER_PID: "4242" }],
	]) {
		const s = await copilotSession(t, { client, env });
		await s.append([copilot.start(SESSION), ...copilotTurn(9), ...copilotStopped(SESSION, { hookId: "stop-0", timestamp: 1 })]);
		await s.run("session-start", { source: "resume" });
		await s.append([...copilotTurn(5), ...stopping()]);
		await s.run("stop");

		assert.deepEqual(s.workers, [SESSION], client);
		assert.deepEqual(await takeJob(s.dataDir, SESSION), {
			host: "copilot",
			sessionId: SESSION,
			transcriptPath: s.transcriptPath,
			end: await s.size(),
			stopId: "stop-1",
			projectDir: "/work/project",
		});
		assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 5 });
		assert.deepEqual(await s.skips(), [["queued", undefined, 5]]);
	}
});

test("the Copilot stop hook waits for Copilot to write the turn, which it does in batches, up to the stop's own hook.start", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	await s.append([copilot.start(SESSION), copilot.prompt("Set up the dev database")]);
	const stopped = s.run("stop");
	await sleep(150);
	// Another stop's hooks, such as a subagent's, started in the same session.
	await s.append([...copilotTurn(5).slice(1), copilot.hookStart("sub-stop", "agentStop", { sessionId: "agent-1", agentId: "agent-1", timestamp: COPILOT_STOP_TIME - 5 })]);
	await sleep(150);
	await s.append([...stopping(), copilot.hookEnd("stop-1", "agentStop"), ...copilotTurn(3)]);
	await stopped;
	const job = await takeJob(s.dataDir, SESSION);
	assert.equal(job.stopId, "stop-1");
	const text = await fs.readFile(s.transcriptPath, "utf8");
	assert.equal(JSON.parse(text.slice(0, job.end).trim().split("\n").at(-1)).data.hookInvocationId, "stop-1");
	assert.deepEqual(await s.state(), { offset: job.end, toolCalls: 5 });
});

test("readCopilotTurn waits for Copilot to create the events file, and gives up waiting for the stop's hook.start after its timeout", async (t) => {
	const s = await copilotSession(t);
	const stop = { sessionId: SESSION, timestamp: COPILOT_STOP_TIME };
	assert.deepEqual(await readCopilotTurn(s.transcriptPath, 0, stop, { timeoutMs: 100 }), { next: 0, toolCalls: 0, mode: undefined, stopId: undefined, fusion: undefined });
	const reading = readCopilotTurn(s.transcriptPath, 0, stop, { timeoutMs: 5000 });
	await sleep(150);
	await s.append([copilot.start(SESSION), ...copilotTurn(5), ...stopping()]);
	assert.deepEqual(await reading, { next: await s.size(), toolCalls: 5, mode: "interactive", stopId: "stop-1", fusion: undefined });

	await s.append(copilotTurn(2).slice(1));
	const late = await readCopilotTurn(s.transcriptPath, 0, { ...stop, timestamp: 2 }, { timeoutMs: 100 });
	assert.deepEqual(late, { next: await s.size(), toolCalls: 7, mode: "interactive", stopId: undefined, fusion: undefined });
});

test("a fusion turn's stop is queued with its tool calls still to be counted, since Copilot writes them after the stop", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	// The d113e250 order of a VS Code Auto turn: only the hooks of its five tool calls precede the stop.
	await s.append([copilot.start(SESSION), ...copilotFusionTurn("fusion-1", 5).before, ...stopping()]);
	await s.run("stop");

	assert.deepEqual(s.workers, [SESSION]);
	assert.deepEqual(await takeJob(s.dataDir, SESSION), {
		host: "copilot",
		sessionId: SESSION,
		transcriptPath: s.transcriptPath,
		end: await s.size(),
		stopId: "stop-1",
		fusion: "fusion-1",
		toolCalls: 0,
		projectDir: "/work/project",
	});
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 0, fusion: "fusion-1" });
	assert.deepEqual(await s.skips(), [["queued", undefined, 0]]);
	assert.match(await fs.readFile(path.join(s.dataDir, "auto-learn.log"), "utf8"), /"fusion":true/);
});

test("the block that Copilot commits after a fusion turn's stop is not counted for the next turn, whether that is a fusion turn or not", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	const first = copilotFusionTurn("fusion-1", 5);
	const second = copilotFusionTurn("fusion-2", 1);
	await s.append([copilot.start(SESSION), ...first.before, ...stopping({ timestamp: 1 })]);
	await s.run("stop", { timestamp: 1 });
	await s.append([copilot.hookEnd("stop-1", "agentStop"), ...first.after, ...second.before, ...stopping({ hookId: "stop-2", timestamp: 2 })]);
	await s.run("stop", { timestamp: 2 });
	await takeJob(s.dataDir, SESSION);
	assert.deepEqual(await takeJob(s.dataDir, SESSION), {
		host: "copilot",
		sessionId: SESSION,
		transcriptPath: s.transcriptPath,
		end: await s.size(),
		stopId: "stop-2",
		fusion: "fusion-2",
		toolCalls: 0,
		projectDir: "/work/project",
	});

	// The user then picks a model that is not a fusion model, and its turn made two tool calls.
	await s.append([copilot.hookEnd("stop-2", "agentStop"), ...second.after, ...copilotTurn(2), ...stopping({ hookId: "stop-3", timestamp: 3 })]);
	await s.run("stop", { timestamp: 3 });
	assert.equal(await takeJob(s.dataDir, SESSION), undefined);
	assert.deepEqual((await s.skips()).at(-1), ["skip", "fewer than 5 tool calls", 2]);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 2 });
});

test("a fusion turn that stops more than once, as a cascade does, is queued at each of its main stops, and its subagents' stops are left out", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	const subagentStop = (id) => copilot.hookStart(id, "agentStop", { sessionId: id, agentId: id, timestamp: 9 });
	await s.append([copilot.start(SESSION), ...copilotFusionTurn("fusion-1", 3).before, subagentStop("agent-1"), ...stopping({ timestamp: 1 })]);
	await s.run("stop", { timestamp: 1 });
	await s.append([copilot.hookEnd("stop-1", "agentStop"), subagentStop("agent-2"), ...stopping({ hookId: "stop-2", timestamp: 2 })]);
	await s.run("stop", { timestamp: 2 });

	const jobs = [await takeJob(s.dataDir, SESSION), await takeJob(s.dataDir, SESSION)];
	assert.deepEqual(jobs.map((job) => [job.stopId, job.fusion, job.toolCalls]), [["stop-1", "fusion-1", 0], ["stop-2", "fusion-1", 0]]);
	assert.deepEqual(await s.state(), { offset: jobs[1].end, toolCalls: 0, fusion: "fusion-1" });
});

test("the calls that Copilot commits for an interrupted fusion turn, which it never completes, are not counted for the next turn", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	// The d113e250-style turn is aborted before its stop, yet its block of ten calls is committed.
	const interrupted = copilotFusionTurn("fusion-1", 10);
	const next = copilotFusionTurn("fusion-2", 1);
	await s.append([copilot.start(SESSION), ...interrupted.before, ...interrupted.after.slice(0, -1), ...next.before, ...stopping()]);
	await s.run("stop");
	const job = await takeJob(s.dataDir, SESSION);
	assert.deepEqual([job.fusion, job.toolCalls], ["fusion-2", 0]);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 0, fusion: "fusion-2" });
});

test("a plain turn after an interrupted fusion turn is counted by itself, and is not taken for the interrupted turn", async (t) => {
	for (const [calls, queued] of [[5, true], [2, false]]) {
		const s = await copilotSession(t);
		await s.run("session-start");
		// Copilot commits the block of the interrupted turn, which has no stop and no completion, and the next turn is on a model that is not a fusion model.
		const interrupted = copilotFusionTurn("fusion-1", 6);
		await s.append([copilot.start(SESSION), ...interrupted.before, ...interrupted.after.slice(0, -1), ...copilotTurn(calls), ...stopping()]);
		await s.run("stop");
		if (queued) assert.deepEqual(await takeJob(s.dataDir, SESSION), { host: "copilot", sessionId: SESSION, transcriptPath: s.transcriptPath, end: await s.size(), stopId: "stop-1", projectDir: "/work/project" });
		else assert.deepEqual((await s.skips()).at(-1), ["skip", "fewer than 5 tool calls", calls]);
		assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: calls });
	}
});

test("a fusion turn that Copilot does not complete after its stop does not turn the plain turns after it into fusion turns", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	const first = copilotFusionTurn("fusion-1", 3);
	await s.append([copilot.start(SESSION), ...first.before, ...stopping({ timestamp: 1 })]);
	await s.run("stop", { timestamp: 1 });
	assert.equal((await s.state()).fusion, "fusion-1");
	// Its block ends early, and the next turn is a plain one.
	await s.append([copilot.hookEnd("stop-1", "agentStop"), ...first.after.slice(0, 4), ...copilotTurn(5), ...stopping({ hookId: "stop-2", timestamp: 2 })]);
	await s.run("stop", { timestamp: 2 });
	assert.equal((await takeJob(s.dataDir, SESSION)).fusion, "fusion-1");
	assert.deepEqual(await takeJob(s.dataDir, SESSION), { host: "copilot", sessionId: SESSION, transcriptPath: s.transcriptPath, end: await s.size(), stopId: "stop-2", projectDir: "/work/project" });
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 5 });
});

test("a Copilot session counts as attended by its client_name when it has no last_client_name, and with the name in quotes", async (t) => {
	for (const yaml of ["client_name: vscode-agent-host\n", 'client_name: github/cli\nlast_client_name: "vscode-agent-host"\n', "last_client_name: 'vscode-agent-host'\n"]) {
		const s = await copilotSession(t, { client: null });
		await fs.writeFile(path.join(path.dirname(s.transcriptPath), "workspace.yaml"), `id: ${SESSION}\n${yaml}`);
		await s.run("session-start");
		await s.append([copilot.start(SESSION), ...copilotTurn(5), ...stopping()]);
		await s.run("stop");
		assert.deepEqual(s.workers, [SESSION], yaml);
	}
});

test("a turn that another plugin's stop hook continues stops again, and its tool calls add up across the stops", async (t) => {
	for (const [active, logged] of [
		[true, ["queued", undefined, 6]],
		[false, ["skip", "fewer than 5 tool calls", 3]],
	]) {
		const s = await copilotSession(t);
		await s.run("session-start");
		await s.append([copilot.start(SESSION), ...copilotTurn(3), ...stopping({ timestamp: 1 })]);
		await s.run("stop", { timestamp: 1 });
		assert.deepEqual(await s.skips(), [["skip", "fewer than 5 tool calls", 3]]);

		// The stop hook's decision makes Copilot send its reason as the next prompt.
		const blocked = copilot.hookEnd("stop-1", "agentStop", { decision: "block", reason: "Check once more." });
		await s.append([blocked, copilot.prompt("Check once more.", "queued"), ...copilotTurn(3).slice(1), ...stopping({ hookId: "stop-2", timestamp: 2 })]);
		await s.run("stop", { timestamp: 2, stop_hook_active: active });
		assert.deepEqual((await s.skips()).at(-1), logged, `stop_hook_active ${active}`);
		assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: active ? 6 : 3 });
	}
});

test("with autoCapture off the Copilot stop hook only keeps its place in the session's events", async (t) => {
	const s = await copilotSession(t, { env: { CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "false" } });
	await s.run("session-start");
	await s.append([copilot.start(SESSION), ...copilotTurn(5), ...stopping()]);
	await s.run("stop");
	assert.deepEqual(s.workers, []);
	assert.equal(await takeJob(s.dataDir, SESSION), undefined);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 5 });
	await assert.rejects(fs.access(path.join(s.dataDir, "auto-learn.log")), { code: "ENOENT" });
});

test("ending a Copilot session forgets its state, which is what stops its reviews", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });
	await s.run("session-end");
	assert.equal(await s.state(), undefined);
});

test("without COPILOT_PROJECT_DIR the capture runs in the hook's working directory", async (t) => {
	const s = await copilotSession(t, { env: { COPILOT_PROJECT_DIR: "" } });
	await s.run("session-start");
	await s.append([copilot.start(SESSION), ...copilotTurn(5), ...stopping()]);
	await s.run("stop");
	assert.equal((await takeJob(s.dataDir, SESSION)).projectDir, "/work/elsewhere");
});

test("Copilot turns are skipped with nobody at the keyboard, in plan or autopilot mode, or with too few tool calls", async (t) => {
	const cases = [
		[{ client: "github/cli" }, {}, "unattended session"],
		[{ client: null, env: { COPILOT_LOADER_PID: "4242" } }, {}, "unattended session"],
		[{}, { mode: "plan" }, "plan mode"],
		[{}, { mode: "autopilot" }, "autopilot mode"],
		[{}, { count: 4 }, "fewer than 5 tool calls"],
	];
	for (const [session, { mode, count = 5 }, reason] of cases) {
		const s = await copilotSession(t, session);
		await s.run("session-start");
		await s.append([copilot.start(SESSION), ...copilotTurn(count, { mode }), ...stopping()]);
		await s.run("stop");
		assert.deepEqual(s.workers, [], reason);
		assert.equal(await takeJob(s.dataDir, SESSION), undefined, reason);
		assert.deepEqual(await s.skips(), [["skip", reason, count]], reason);
		assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: count }, reason);
	}
});

test("a Copilot turn's mode is the mode of its last model round", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	// The user switched from plan mode to the interactive mode during the turn.
	await s.append([copilot.start(SESSION), ...copilotTurn(5, { mode: "plan" }), copilot.turnStart("7", "interactive"), ...stopping()]);
	await s.run("stop");
	assert.deepEqual(s.workers, [SESSION]);
});

test("a Copilot subagent's stop is left out, and so are the subagent's tool calls in the main agent's turn", async (t) => {
	const s = await copilotSession(t);
	await s.run("session-start");
	const subagentCalls = [1, 2, 3].map((i) => copilot.toolStart(`sub-${i}`, "view", { parentToolCallId: "call-task" }));
	await s.append([copilot.start(SESSION), ...copilotTurn(4), ...subagentCalls, ...stopping()]);
	// A subagent's stop names the subagent as sessionId, with the main agent's events file.
	await s.run("stop", { sessionId: "task-agent-1", agentId: "task-agent-1", agentType: "explore", parentAgentId: SESSION });
	await s.run("stop", { agentId: "task-agent-2" });
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });

	await s.run("stop");
	assert.deepEqual(await s.skips(), [["skip", "fewer than 5 tool calls", 4]]);
});

test("a Copilot stop without the session's saved state is not reviewed, and the next turn starts there", async (t) => {
	const s = await copilotSession(t);
	await s.append([copilot.start(SESSION), ...copilotTurn(5), ...stopping()]);
	await s.run("stop");
	assert.deepEqual(s.workers, []);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 0 });
	assert.deepEqual(await s.skips(), [["skip", "no saved state for the session", 0]]);
});

test("a Copilot stop whose saved place is past the end of the events file starts over, as without saved state", async (t) => {
	const s = await copilotSession(t);
	await s.append([copilot.start(SESSION), ...copilotTurn(5), ...stopping()]);
	await writeSessionState(s.dataDir, SESSION, { offset: (await s.size()) + 1000, toolCalls: 3 });
	await s.run("stop");
	assert.deepEqual(s.workers, []);
	assert.deepEqual(await s.state(), { offset: await s.size(), toolCalls: 0 });
	assert.deepEqual(await s.skips(), [["skip", "no saved state for the session", 0]]);
});

test("Copilot hooks read the sessionId and transcriptPath that Copilot's own hook events send", async (t) => {
	const s = await copilotSession(t);
	await assert.rejects(s.run("session-start", { sessionId: undefined, session_id: SESSION }), /The hook input has no usable sessionId: undefined\./);
	await s.run("session-start");
	await assert.rejects(s.run("stop", { transcriptPath: "events.jsonl" }), /no usable transcriptPath/);
});

test("the hook script answers Copilot's sessionStart with additionalContext on stdout", async (t) => {
	const s = await copilotSession(t);
	const stdout = await new Promise((resolve, reject) => {
		const child = execFile(process.execPath, [HOOK_SCRIPT, "session-start", "--host=copilot"], { env: { ...process.env, ...s.env } }, (error, out) => (error ? reject(error) : resolve(out)));
		child.stdin.end(JSON.stringify({ sessionId: SESSION, timestamp: COPILOT_STOP_TIME, cwd: "/work/project", source: "new" }));
	});
	assert.match(JSON.parse(stdout).additionalContext, /^# Skill library\n/);
});
