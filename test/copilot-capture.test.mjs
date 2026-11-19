import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { captureCopilotTurn, runCopilotFork } from "../scripts/lib/copilot.mjs";
import { captureNudge } from "../scripts/lib/prompts.mjs";
import { queueCapture, writeSessionState } from "../scripts/lib/state.mjs";
import { copilot, copilotFusionTurn, copilotStopped, copilotTurn, tempDir, toJsonl } from "./helpers.mjs";

const FAKE_COPILOT = new URL("./fake-copilot.mjs", import.meta.url).pathname;
const SESSION = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
// What Copilot CLI and VS Code's agent host add to the environment of the session's hooks.
const HOOK_ENV = {
	AI_AGENT: "github_copilot_vscode_agent",
	AUTO_APPROVAL: "true",
	CLAUDE_PLUGIN_DATA: "/plugin-data",
	CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "true",
	CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "5",
	CLAUDE_PLUGIN_ROOT: "/plugin",
	CLAUDE_PROJECT_DIR: "/work/project",
	COPILOT_AGENT_SESSION_ID: "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b",
	COPILOT_CLI: "1",
	COPILOT_CLI_RUN_AS_NODE: "1",
	COPILOT_DETACHED_PARENT_ENGAGEMENT_ID: "engagement",
	COPILOT_DETACHED_PARENT_SESSION_ID: "parent-session",
	COPILOT_DETACHED_SESSION: "1",
	COPILOT_HOOK_DEPTH: "1",
	COPILOT_HOOK_DIR: "/plugin",
	COPILOT_LOADER_PID: "4242",
	COPILOT_PLUGIN_DATA: "/plugin-data",
	COPILOT_PLUGIN_ROOT: "/plugin",
	COPILOT_PROJECT_DIR: "/work/project",
	COPILOT_SESSION_CWD: "/work/project",
	COPILOT_TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
	COPILOT_TRACESTATE: "vendor=1",
	ELECTRON_RUN_AS_NODE: "1",
	PLUGIN_ROOT: "/plugin",
};
// What the review keeps of the session's environment: the Copilot folder, the hook depth Copilot counts up for other plugins' hooks, and COPILOT_CLI, which Copilot sets for every hook and shell command anyway.
const KEPT = new Set(["COPILOT_CLI", "COPILOT_HOME", "COPILOT_HOOK_DEPTH"]);
const REVIEW_ARGS = (forkId) => [
	"-p",
	captureNudge("auto-learn-manage_skill", "copilot"),
	"--resume",
	forkId,
	"--mode",
	"interactive",
	"--available-tools",
	"mcp:auto-learn-manage_skill",
	"--allow-tool",
	"auto-learn(manage_skill)",
	"--no-ask-user",
	"--sync-session=off",
	"--no-auto-update",
];

const STOPPED = copilotStopped(SESSION);

/**
 * A temporary world: a fake copilot on PATH, a project, and a session in
 * COPILOT_HOME whose events file holds `events` up to the job's end, the
 * start of the agentStop hooks that queued the job, then `after`.
 */
async function world(t, mode, { events = [copilot.start(SESSION), ...copilotTurn(5), ...STOPPED.slice(0, 3)], after = STOPPED.slice(3), env: extraEnv = {}, job: jobFields = {} } = {}) {
	const root = await tempDir(t);
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	await fs.writeFile(path.join(bin, "copilot"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_COPILOT}" "$@"\n`, { mode: 0o755 });
	const record = path.join(root, "record.jsonl");
	const env = {
		...process.env,
		...HOOK_ENV,
		PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		FAKE_COPILOT_MODE: mode,
		FAKE_COPILOT_RECORD: record,
		COPILOT_HOME: path.join(root, "copilot"),
		...extraEnv,
	};
	delete env.AUTO_LEARN_CAPTURE;
	const projectDir = path.join(root, "project");
	await fs.mkdir(projectDir);
	const stateDir = path.join(env.COPILOT_HOME, "session-state");
	await fs.mkdir(path.join(stateDir, SESSION), { recursive: true });
	const transcriptPath = path.join(stateDir, SESSION, "events.jsonl");
	await fs.writeFile(transcriptPath, toJsonl(events));
	const end = (await fs.stat(transcriptPath)).size;
	await fs.appendFile(transcriptPath, toJsonl(after));
	const job = { host: "copilot", sessionId: SESSION, transcriptPath, end, stopId: "stop-1", projectDir, ...jobFields };
	const recorded = async () => {
		try {
			return (await fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
	};
	const review = async () => (await recorded()).find((entry) => entry.command === "review");
	// The session folders in session-state, and the operation locks Copilot keeps there.
	const sessions = async () => {
		const entries = await fs.readdir(stateDir);
		const locks = entries.includes(".session-operation-locks") ? await fs.readdir(path.join(stateDir, ".session-operation-locks")) : [];
		return [...entries.filter((entry) => entry !== ".session-operation-locks"), ...locks];
	};
	return { root, env, job, record, recorded, review, sessions, source: await fs.readFile(transcriptPath) };
}

/**
 * A fusion turn's world: the session holds the turn up to its stop, as it does
 * when the stop's hooks run, then the end of the stop's hooks, `mid`, and
 * unless `committed` is false, the block that Copilot commits for the turn.
 */
async function fusionWorld(t, { count = 5, mode, mid = [], committed = true, toolCalls = 0, block = STOPPED[3], env } = {}) {
	const turn = copilotFusionTurn("fusion-1", count, { mode });
	const w = await world(t, "ok", {
		events: [copilot.start(SESSION), ...turn.before, ...STOPPED.slice(0, 3)],
		after: [block, ...mid, ...(committed ? turn.after : [])],
		job: { fusion: "fusion-1", toolCalls },
		env,
	});
	return { ...w, turn };
}

const capture = (w, options = {}) => captureCopilotTurn(w.job, { env: w.env, ...options });

test("captureCopilotTurn reviews a copy of the session up to the turn's agentStop hooks through copilot -p, then deletes the copy", async (t) => {
	const w = await world(t, "ok");
	const record = await capture(w);
	const { durationMs, ...rest } = record;
	assert.ok(Number.isInteger(durationMs));
	assert.deepEqual(rest, {
		outcome: "ok",
		skillCalls: 1,
		otherToolCalls: 0,
		otherTools: [],
		aiCredits: 0.123457,
		inputTokens: 4100,
		cacheReadTokens: 1900,
		outputTokens: 60,
		created: ["fake-skill"],
		updated: [],
		deleted: [],
	});

	const review = await w.review();
	const forkId = review.args[3];
	assert.match(forkId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.notEqual(forkId, SESSION);
	assert.deepEqual(review.args, REVIEW_ARGS(forkId));
	assert.equal(review.cwd, w.job.projectDir);
	// The review is a session of its own: none of the session's hook, plugin or runtime variables, and no capture of the review.
	for (const key of Object.keys(HOOK_ENV)) if (!KEPT.has(key)) assert.equal(review.env[key], undefined, key);
	assert.deepEqual([review.env.AUTO_LEARN_CAPTURE, review.env.COPILOT_HOME, review.env.COPILOT_HOOK_DEPTH], ["1", w.env.COPILOT_HOME, "1"]);

	// The copy is the session up to the stop's hook.end, under the new session's id.
	const source = w.source.toString().split("\n");
	const copy = review.copy.split("\n");
	const stopEnd = source.findIndex((line) => line && JSON.parse(line).type === "hook.end");
	assert.equal(copy.length, stopEnd + 2);
	assert.equal(copy.at(-1), "");
	assert.deepEqual(copy.slice(1, -1), source.slice(1, stopEnd + 1));
	const [start, copyStart] = [JSON.parse(source[0]), JSON.parse(copy[0])];
	assert.equal(copyStart.data.sessionId, forkId);
	assert.notEqual(copyStart.data.startTime, start.data.startTime);
	assert.deepEqual({ ...copyStart, data: { ...copyStart.data, sessionId: SESSION, startTime: start.data.startTime } }, start);
	assert.ok(review.workspace.includes(`id: "${forkId}"\n`), review.workspace);
	assert.ok(review.workspace.includes(`cwd: ${JSON.stringify(w.job.projectDir)}\n`), review.workspace);
	assert.ok(review.workspace.includes('client_name: "github/cli"\n'), review.workspace);
	assert.equal(review.lock, true);

	// The session itself is only read, and the copy is gone with Copilot's record of it.
	assert.deepEqual(await fs.readFile(w.job.transcriptPath), w.source);
	assert.deepEqual(await w.sessions(), [SESSION]);
	const received = (await w.recorded()).filter((entry) => entry.received).map((entry) => entry.received);
	assert.deepEqual(received, [
		{ jsonrpc: "2.0", id: 1, method: "connect", params: { supportedTaskKinds: ["agent", "client", "shell"] } },
		{ jsonrpc: "2.0", id: "server-1", error: { code: -32601, message: "auto-learn does not answer client.capabilities" } },
		{ jsonrpc: "2.0", id: 2, method: "session.delete", params: { sessionId: forkId } },
	]);
	const headless = (await w.recorded()).find((entry) => entry.command === "headless");
	assert.deepEqual(headless.args, ["--headless", "--no-auto-update", "--stdio"]);
	assert.equal(headless.env.AUTO_LEARN_CAPTURE, "1");
});

test("captureCopilotTurn waits for the end of the stop that queued it, not another hook's", async (t) => {
	// A subagent's stop hooks end while the main agent's run.
	const others = [copilot.hookStart("sub-stop", "agentStop", { sessionId: "agent-1", agentId: "agent-1" }), copilot.hookEnd("sub-stop", "agentStop")];
	const w = await world(t, "ok", { after: [] });
	const captured = capture(w);
	await sleep(300);
	assert.deepEqual(await w.recorded(), [], "the review waits for the stop's hooks");
	await fs.appendFile(w.job.transcriptPath, toJsonl([...others, ...STOPPED.slice(3), copilot.hookStart("end-1", "sessionEnd")]));
	assert.equal((await captured).outcome, "ok");
	assert.equal(JSON.parse((await w.review()).copy.trim().split("\n").at(-1)).id, STOPPED[3].id);
});

test("captureCopilotTurn skips a turn whose stop hook asked for it to go on, since the stop that ends the turn is the one reviewed", async (t) => {
	const w = await world(t, "ok", { after: [copilot.hookEnd("stop-1", "agentStop", { decision: "block", reason: "Check once more." })] });
	assert.deepEqual(await capture(w), { outcome: "skipped", reason: "a stop hook continued the turn" });
	assert.deepEqual(await w.recorded(), [], "copilot must not run");
});

test("captureCopilotTurn reviews a fusion turn once Copilot has committed it, in a copy that ends with the turn's completion", async (t) => {
	const subagentStop = [copilot.hookStart("sub-stop", "agentStop", { sessionId: "agent-1", agentId: "agent-1", timestamp: 9 }), copilot.hookEnd("sub-stop", "agentStop")];
	const w = await fusionWorld(t, { mid: subagentStop });
	assert.equal((await capture(w)).outcome, "ok");
	const copy = (await w.review()).copy.trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual([copy.at(-1).type, copy.at(-1).data.fusionId], ["session.fusion_completed", "fusion-1"]);
	assert.equal(copy.filter((event) => event.type === "tool.execution_start").length, 5);
});

test("a fusion turn whose stop hook asked for it to go on is skipped, like a plain turn", async (t) => {
	const w = await fusionWorld(t, { block: copilot.hookEnd("stop-1", "agentStop", { decision: "block", reason: "Check once more." }) });
	assert.deepEqual(await capture(w), { outcome: "skipped", reason: "a stop hook continued the turn" });
	assert.deepEqual(await w.recorded(), []);
});

test("a fusion job counts the tool calls its hook carried from earlier stops of the turn together with those Copilot commits", async (t) => {
	const w = await fusionWorld(t, { count: 2, toolCalls: 3 });
	assert.equal((await capture(w)).outcome, "ok");
	const short = await fusionWorld(t, { count: 1, toolCalls: 3 });
	assert.deepEqual(await capture(short), { outcome: "skipped", reason: "fewer than 5 tool calls" });
});

test("for a fusion turn only the main agent's tool calls and model rounds count, and only the turn's own completion ends it", async (t) => {
	const subagent = (event) => ({ ...event, data: { ...event.data, parentToolCallId: "parent-call" } });
	for (const [count, outcome] of [[5, "ok"], [4, "skipped"]]) {
		const turn = copilotFusionTurn("fusion-1", count);
		// The main agent's first round is in plan mode and its last is not.
		turn.after.find((event) => event.type === "assistant.turn_start").data.agentMode = "plan";
		const [commit, ...rounds] = turn.after.slice(0, -1);
		const block = [commit, copilot.fusionDone("another-fusion"), ...rounds, subagent(copilot.turnStart("sub-1", "plan")), ...["a", "b", "c"].map((id) => subagent(copilot.toolStart(`sub-call-${id}`))), turn.after.at(-1)];
		const w = await world(t, "ok", { events: [copilot.start(SESSION), ...turn.before, ...STOPPED.slice(0, 3)], after: [STOPPED[3], ...block], job: { fusion: "fusion-1", toolCalls: 0 } });
		assert.equal((await capture(w)).outcome, outcome, `${count} main calls`);
	}
});

test("a session whose events file does not start with session.start is reported as an error, without running copilot", async (t) => {
	const w = await world(t, "ok", { events: [copilot.prompt("Set up the dev database"), ...copilotTurn(5).slice(1), ...STOPPED.slice(0, 3)] });
	const result = await capture(w);
	assert.equal(result.outcome, "error");
	assert.match(result.error, /does not start with session\.start/);
	assert.deepEqual(await w.recorded(), []);
	assert.deepEqual(await w.sessions(), [SESSION]);
});

test("captureCopilotTurn waits for the block that Copilot commits after a fusion turn's stop", async (t) => {
	const w = await fusionWorld(t, { committed: false });
	const captured = capture(w);
	await sleep(300);
	assert.deepEqual(await w.recorded(), [], "the review waits for the turn's completion");
	await fs.appendFile(w.job.transcriptPath, toJsonl(w.turn.after));
	assert.equal((await captured).outcome, "ok");
	assert.equal((await w.review()).copy.trim().split("\n").filter((line) => JSON.parse(line).type === "tool.execution_start").length, 5);
});

test("a fusion turn is counted when it is complete: too few tool calls, plan mode and autopilot mode skip it, and minToolCalls decides", async (t) => {
	for (const [options, reason] of [
		[{ count: 4 }, "fewer than 5 tool calls"],
		[{ mode: "plan" }, "plan mode"],
		[{ mode: "autopilot" }, "autopilot mode"],
	]) {
		const w = await fusionWorld(t, options);
		assert.deepEqual(await capture(w), { outcome: "skipped", reason }, reason);
		assert.deepEqual(await w.recorded(), [], reason);
	}
	const few = await fusionWorld(t, { count: 2, env: { CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "2" } });
	assert.equal((await capture(few)).outcome, "ok");
});

test("of the stops of a fusion turn that stops more than once, only the last is reviewed", async (t) => {
	const turn = copilotFusionTurn("fusion-1", 5);
	const stopped = [copilot.start(SESSION), ...turn.before, ...STOPPED.slice(0, 3), STOPPED[3]];
	const secondStop = [copilot.hookStart("stop-2", "agentStop", { sessionId: SESSION, timestamp: 2 }), copilot.hookEnd("stop-2", "agentStop")];
	const first = await world(t, "ok", { events: stopped.slice(0, -1), after: [STOPPED[3], ...secondStop, ...turn.after], job: { fusion: "fusion-1", toolCalls: 0 } });
	assert.deepEqual(await capture(first), { outcome: "skipped", reason: "a later stop ended the turn" });
	assert.deepEqual(await first.recorded(), []);

	const last = await world(t, "ok", { events: [...stopped, secondStop[0]], after: [secondStop[1], ...turn.after], job: { fusion: "fusion-1", toolCalls: 0, stopId: "stop-2" } });
	assert.equal((await capture(last)).outcome, "ok");
});

test("captureCopilotTurn skips a fusion turn that Copilot interrupts, which is followed by the next turn instead of its completion", async (t) => {
	const turn = copilotFusionTurn("fusion-1", 5);
	const w = await world(t, "ok", {
		events: [copilot.start(SESSION), ...turn.before, ...STOPPED.slice(0, 3)],
		after: [STOPPED[3], ...turn.after.slice(0, -1), copilot.fusionResolved("fusion-2")],
		job: { fusion: "fusion-1", toolCalls: 0 },
	});
	assert.deepEqual(await capture(w), { outcome: "skipped", reason: "the turn's fusion ended without completing" });
	assert.deepEqual(await w.recorded(), []);
});

test("a review that is aborted after its copy was made still deletes the copy and Copilot's lock on it", async (t) => {
	const w = await world(t, "hang");
	const controller = new AbortController();
	const captured = capture(w, { signal: controller.signal });
	try {
		// The fake takes the copy's lock after it records the review.
		for (let i = 0; i < 500 && (await w.sessions()).length < 3; i++) await sleep(20);
		assert.equal((await w.sessions()).length, 3, "the session, its copy and the copy's lock");
	} finally {
		controller.abort("the session ended");
	}
	assert.equal((await captured).outcome, "aborted");
	assert.deepEqual(await w.sessions(), [SESSION]);
});

test("a manage_skill call that fails saves nothing, and calls to hidden tools are counted and named without their arguments", async (t) => {
	const w = await world(t, "refused");
	const record = await capture(w);
	assert.equal(record.outcome, "ok");
	assert.deepEqual([record.skillCalls, record.otherToolCalls, record.otherTools], [1, 1, ["bash"]]);
	assert.deepEqual([record.created, record.updated, record.deleted], [[], [], []]);
	assert.doesNotMatch(JSON.stringify(record), /credentials|Not A Name/);
});

test("a review that copilot fails is reported with copilot's error output, and its copy is still deleted", async (t) => {
	const w = await world(t, "exit");
	const record = await capture(w);
	assert.equal(record.outcome, "error");
	assert.equal(record.error, "copilot exited (3) before the review ended: Error: No model available. Check your Copilot subscription.");
	assert.equal(record.skillCalls, 0);
	assert.equal(record.cleanupError, undefined);
	assert.deepEqual(await w.sessions(), [SESSION]);
});

test("when copilot --headless will not delete the copy, its folder is removed and the error logged", async (t) => {
	const w = await world(t, "ok", { env: { FAKE_COPILOT_DELETE: "fail" } });
	const record = await capture(w);
	assert.equal(record.outcome, "ok");
	assert.equal(record.cleanupError, "copilot --headless did not delete the review's session: Session is in use");
	assert.deepEqual(await w.sessions(), [SESSION]);
});

test("without copilot on PATH the review fails, and the copy is removed", async (t) => {
	const w = await world(t, "ok");
	const record = await capture(w, { env: { ...w.env, PATH: path.join(w.root, "bin-empty") } });
	assert.equal(record.outcome, "error");
	assert.equal(record.error, "the copilot CLI was not found on PATH");
	assert.equal(record.cleanupError, "the copilot CLI was not found on PATH");
	assert.deepEqual(await w.sessions(), [SESSION]);
});

test("captureCopilotTurn skips a malformed job and a gone project, and stops waiting for the turn's end once aborted, without running copilot", async (t) => {
	const w = await world(t, "ok");
	for (const job of [{ ...w.job, sessionId: "../s1" }, { ...w.job, transcriptPath: "events.jsonl" }, { ...w.job, end: -1 }, { ...w.job, stopId: undefined }, { ...w.job, fusion: "fusion-1" }, { ...w.job, fusion: "", toolCalls: 0 }, { ...w.job, projectDir: "" }]) {
		assert.deepEqual(await captureCopilotTurn(job, { env: w.env }), { outcome: "skipped", reason: "malformed job" });
	}
	const waiting = await world(t, "ok", { after: [] });
	assert.deepEqual(await capture(waiting, { signal: AbortSignal.abort("the session ended") }), { outcome: "aborted", reason: "the session ended" });
	await fs.rm(w.job.projectDir, { recursive: true });
	assert.deepEqual(await capture(w), { outcome: "skipped", reason: "the session's project directory is gone" });
	for (const world of [w, waiting]) assert.deepEqual(await world.recorded(), [], "copilot must not run");
	assert.deepEqual(await w.sessions(), [SESSION]);
});

test("runCopilotFork kills a review that ignores SIGTERM, and reports a stopped review that exits cleanly as stopped", { timeout: 30000 }, async (t) => {
	const run = async (mode) => {
		const w = await world(t, mode);
		const started = Date.now();
		const result = await runCopilotFork({ forkId: SESSION, cwd: w.job.projectDir, env: w.env, timeoutMs: 300, killGraceMs: 300 });
		return [result, Date.now() - started];
	};
	// The stubborn fake gives up by itself after 5 seconds, which is when a review that is never killed would end.
	const [stubborn, took] = await run("stubborn");
	assert.deepEqual(stubborn, { outcome: "timeout" });
	assert.ok(took < 3000, `a review that ignores SIGTERM is killed when the grace period ends, not when it exits (${took} ms)`);
	assert.deepEqual((await run("polite"))[0], { outcome: "timeout" });
});

test("runCopilotFork stops a review that runs too long or is aborted", async (t) => {
	const w = await world(t, "hang");
	const run = (options) => runCopilotFork({ forkId: SESSION, cwd: w.job.projectDir, env: w.env, ...options });
	assert.deepEqual(await run({ timeoutMs: 300 }), { outcome: "timeout" });
	const controller = new AbortController();
	const pending = run({ signal: controller.signal });
	setTimeout(() => controller.abort("the session ended"), 300);
	assert.deepEqual(await pending, { outcome: "aborted", reason: "the session ended" });
	assert.deepEqual(await run({ signal: AbortSignal.abort("the session ended") }), { outcome: "aborted", reason: "the session ended" });
});

test("the worker script captures a queued Copilot turn and logs it", async (t) => {
	const w = await world(t, "ok");
	const dataDir = path.join(w.root, "data");
	w.env.CLAUDE_PLUGIN_DATA = dataDir;
	await writeSessionState(dataDir, SESSION, { offset: 0, toolCalls: 0 });
	await queueCapture(dataDir, w.job);
	await new Promise((resolve, reject) =>
		execFile(process.execPath, [new URL("../scripts/capture.mjs", import.meta.url).pathname, SESSION], { env: w.env, cwd: dataDir, timeout: 30_000 }, (error) =>
			error ? reject(error) : resolve(),
		),
	);
	const log = (await fs.readFile(path.join(dataDir, "auto-learn.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(
		log.map(({ event, session, outcome, created, aiCredits }) => ({ event, session, outcome, created, aiCredits })),
		[{ event: "capture", session: SESSION, outcome: "ok", created: ["fake-skill"], aiCredits: 0.123457 }],
	);
});
