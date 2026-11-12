import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { captureTurn, drainQueue, GATE_SETTINGS, MANAGE_SKILL_TOOL, runFork } from "../scripts/lib/capture.mjs";
import { captureNudge } from "../scripts/lib/prompts.mjs";
import { acquireLock, forgetSession, queueCapture, takeJob, writeSessionState } from "../scripts/lib/state.mjs";
import { entry, linked, tempDir, toJsonl, turnWithToolCalls } from "./helpers.mjs";

const FAKE_CLAUDE = new URL("./fake-claude.mjs", import.meta.url).pathname;
const WORKER_SCRIPT = new URL("../scripts/capture.mjs", import.meta.url).pathname;
// Some of what Claude Code tells the hooks of the session that ran them.
const PARENT_SESSION_ENV = {
	AI_AGENT: "claude-code",
	CLAUDECODE: "1",
	CLAUDE_CODE_ENTRYPOINT: "cli",
	CLAUDE_CODE_EXECPATH: "/opt/claude/bin/claude",
	CLAUDE_CODE_MESSAGING_TOKEN: "token",
	CLAUDE_CODE_SESSION_ATTENDED: "1",
	CLAUDE_CODE_SESSION_ID: "parent-session",
	CLAUDE_EFFORT: "high",
	CLAUDE_ENV_FILE: "/tmp/session-env",
	CLAUDE_PID: "4242",
	CLAUDE_PLUGIN_DATA: "/plugin-data",
	CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "true",
	CLAUDE_PLUGIN_ROOT: "/plugin",
	CLAUDE_PROJECT_DIR: "/work/project",
	TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};

/**
 * A temporary world: a fake claude on PATH, a skill library, a project, and a
 * transcript holding `entries` as one chain. The job's end is where the Stop
 * hook stopped reading, before the final reply and the stop summary.
 */
async function world(t, mode, entries = [...turnWithToolCalls(5), entry.summary()]) {
	const root = await tempDir(t);
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	await fs.writeFile(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
	const record = path.join(root, "record.json");
	const env = {
		...process.env,
		PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		FAKE_CLAUDE_MODE: mode,
		FAKE_CLAUDE_RECORD: record,
		CLAUDE_PLUGIN_DATA: path.join(root, "data"),
		AUTO_LEARN_SKILLS_DIR: path.join(root, "skills"),
		CLAUDE_CONFIG_DIR: path.join(root, "config"),
	};
	await fs.mkdir(env.CLAUDE_PLUGIN_DATA);
	const projectDir = path.join(root, "project");
	await fs.mkdir(projectDir);
	const chain = linked(entries);
	const transcriptPath = path.join(root, "session.jsonl");
	await fs.writeFile(transcriptPath, toJsonl(chain));
	const job = { sessionId: "s1", transcriptPath, start: 0, end: Buffer.byteLength(toJsonl(chain.slice(0, -2))), projectDir };
	const recorded = async () => JSON.parse(await fs.readFile(record, "utf8"));
	return { root, env, job, record, recorded };
}

const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
const fork = (w, options = {}) => runFork({ sessionId: "s1", forkAt: "u12", cwd: w.job.projectDir, env: w.env, ...options });

/** Writes Claude Code's global configuration, as it reads after `sessionId` exited having cost `costUsd`. */
async function recordSessionCost(w, sessionId, costUsd, text) {
	const lastModelUsage = { "claude-test-1": { costUSD: costUsd - 1 }, "claude-test-2": { costUSD: 1 } };
	const projects = { "/work/project": { lastSessionId: sessionId, lastCost: costUsd, lastModelUsage } };
	await fs.mkdir(w.env.CLAUDE_CONFIG_DIR, { recursive: true });
	await fs.writeFile(path.join(w.env.CLAUDE_CONFIG_DIR, ".claude.json"), text ?? JSON.stringify({ projects }));
}

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

test("runFork forks the session at the turn's end as a new session with every tool but manage_skill refused", async (t) => {
	const w = await world(t, "ok");
	const env = { ...w.env, ...PARENT_SESSION_ENV, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1234" };
	const result = await fork(w, { model: "claude-test-1", effort: "high", env });
	assert.deepEqual(result, {
		outcome: "ok",
		turns: 2,
		costUsd: 0.0123,
		inputTokens: 115,
		cacheReadTokens: 5,
		outputTokens: 20,
		advisorCalls: 0,
		refusedCalls: 0,
	});

	const { args, stdin, cwd, env: forkEnv } = await w.recorded();
	assert.equal(args[0], "-p");
	for (const [flag, value] of [
		["--resume", "s1"],
		["--resume-session-at", "u12"],
		["--output-format", "json"],
		["--permission-mode", "dontAsk"],
		["--settings", GATE_SETTINGS],
		["--max-turns", "10"],
		["--model", "claude-test-1"],
		["--effort", "high"],
	]) {
		assert.equal(flagValue(args, flag), value, flag);
	}
	for (const flag of ["--fork-session", "--no-session-persistence", "--verbose"]) assert.ok(args.includes(flag), flag);
	const allowed = args.indexOf("--allowedTools");
	assert.deepEqual(args.slice(allowed + 1, allowed + 3), [MANAGE_SKILL_TOOL, "ToolSearch"]);
	assert.ok(args[allowed + 3].startsWith("--"), "--allowedTools takes a list, so a flag must end it");
	assert.equal(stdin, captureNudge(MANAGE_SKILL_TOOL));
	assert.equal(cwd, await fs.realpath(w.job.projectDir));

	assert.equal(forkEnv.AUTO_LEARN_CAPTURE, "1");
	assert.equal(forkEnv.AUTO_LEARN_SKILLS_DIR, w.env.AUTO_LEARN_SKILLS_DIR);
	assert.equal(forkEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1234");
	for (const key of Object.keys(PARENT_SESSION_ENV)) assert.equal(forkEnv[key], undefined, `${key} reached the fork`);
});

test("runFork leaves the model and effort to claude when the session's are unknown", async (t) => {
	const w = await world(t, "ok");
	await fork(w);
	const { args } = await w.recorded();
	assert.equal(args.includes("--model"), false);
	assert.equal(args.includes("--effort"), false);
});

test("the gate refuses every tool but manage_skill and ToolSearch", async () => {
	const gate = JSON.parse(GATE_SETTINGS).hooks.PreToolUse;
	assert.equal(gate.length, 1);
	// Claude Code reads a matcher with characters beyond names and | as a regular expression.
	const matches = (tool) => new RegExp(gate[0].matcher).test(tool);
	for (const tool of ["Bash", "Write", "mcp__github__create_issue", "ToolSearchX", `${MANAGE_SKILL_TOOL}2`, "manage_skill"]) {
		assert.ok(matches(tool), `${tool} is not refused`);
	}
	for (const tool of [MANAGE_SKILL_TOOL, "ToolSearch"]) assert.equal(matches(tool), false, `${tool} is refused`);

	const refusal = await new Promise((resolve) =>
		execFile("sh", ["-c", gate[0].hooks[0].command], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })),
	);
	assert.deepEqual(refusal, {
		code: 2,
		stdout: "",
		stderr: "Only manage_skill can run during an automatic skill review; nothing was run.\n",
	});
});

test("runFork counts the fork's advisor calls and the calls the gate refused", async (t) => {
	const w = await world(t, "tools");
	const { advisorCalls, refusedCalls } = await fork(w);
	assert.deepEqual({ advisorCalls, refusedCalls }, { advisorCalls: 1, refusedCalls: 1 });
});

test("a failed, garbled, missing or hung claude is reported, not thrown", async (t) => {
	const failed = await world(t, "fail");
	assert.deepEqual(await fork(failed), {
		outcome: "error",
		turns: 2,
		costUsd: 0.0123,
		inputTokens: 115,
		cacheReadTokens: 5,
		outputTokens: 20,
		advisorCalls: 0,
		refusedCalls: 0,
		error: "Invalid API key",
	});

	const garbled = await world(t, "garbage");
	assert.deepEqual(await fork(garbled), { outcome: "error", error: "claude's output is not a JSON result (exit 0): no error output" });

	const missing = await world(t, "ok");
	assert.deepEqual(await fork(missing, { env: { ...missing.env, PATH: missing.root } }), {
		outcome: "error",
		error: "the claude CLI was not found on PATH",
	});

	const hung = await world(t, "hang");
	assert.deepEqual(await fork(hung, { timeoutMs: 300 }), { outcome: "timeout" });
});

test("the logged cost leaves out the session's earlier cost, which claude counts into a resumed fork's total", async (t) => {
	const resumed = await world(t, "ok");
	await recordSessionCost(resumed, "s1", 11);
	const { costUsd, sessionCostUsd, reportedCostUsd } = await fork(resumed);
	assert.deepEqual({ costUsd, sessionCostUsd, reportedCostUsd }, { costUsd: 0.0123, sessionCostUsd: 11, reportedCostUsd: undefined });

	const other = await world(t, "ok");
	await recordSessionCost(other, "another-session", 11);
	const record = await fork(other);
	assert.deepEqual([record.costUsd, record.sessionCostUsd], [0.0123, undefined]);
});

test("the full total is logged as the cost when the fork did not count on from the session's record", async (t) => {
	const w = await world(t, "ok");
	w.env.FAKE_CLAUDE_RESTORE = "off";
	await recordSessionCost(w, "s1", 11);
	const { costUsd, sessionCostUsd } = await fork(w);
	assert.deepEqual({ costUsd, sessionCostUsd }, { costUsd: 0.0123, sessionCostUsd: undefined });
});

test("when Claude Code's configuration cannot be read, claude's total is logged under its own name", async (t) => {
	const w = await world(t, "ok");
	await recordSessionCost(w, "s1", 11, '{"projects": {');
	const { costUsd, reportedCostUsd } = await fork(w);
	assert.deepEqual({ costUsd, reportedCostUsd }, { costUsd: undefined, reportedCostUsd: 0.0123 });
});

test("runFork stops the fork when aborted, and says why", async (t) => {
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

test("captureTurn forks the session at the turn's last reply and reports the skills the fork saved", async (t) => {
	const w = await world(t, "create");
	const record = await captureTurn(w.job, { env: w.env });
	assert.equal(record.outcome, "ok");
	assert.deepEqual([record.created, record.updated, record.deleted], [["fake-skill"], [], []]);
	assert.equal(record.costUsd, 0.0123);
	assert.ok(Number.isInteger(record.durationMs));
	await fs.access(path.join(w.env.AUTO_LEARN_SKILLS_DIR, "fake-skill", "SKILL.md"));

	const { args, cwd } = await w.recorded();
	assert.equal(flagValue(args, "--resume"), "s1");
	assert.equal(flagValue(args, "--resume-session-at"), "u12");
	assert.equal(flagValue(args, "--model"), "claude-test-1");
	assert.equal(args.includes("--effort"), false);
	assert.equal(cwd, await fs.realpath(w.job.projectDir));
});

test("captureTurn passes on the session's effort level, if it is a plain word", async (t) => {
	const high = await world(t, "ok");
	await captureTurn({ ...high.job, effort: "high" }, { env: high.env });
	assert.equal(flagValue((await high.recorded()).args, "--effort"), "high");

	const odd = await world(t, "ok");
	await captureTurn({ ...odd.job, effort: "--x" }, { env: odd.env });
	assert.equal((await odd.recorded()).args.includes("--effort"), false);
});

test("captureTurn skips a malformed job, a turn that went on after its stop, and a project that is gone, without running claude", async (t) => {
	const w = await world(t, "ok");
	const skip = (job) => captureTurn(job, { env: w.env });
	assert.deepEqual(await skip({ ...w.job, start: 9, end: 3 }), { outcome: "skipped", reason: "malformed job" });
	assert.deepEqual(await skip({ ...w.job, sessionId: "-x" }), { outcome: "skipped", reason: "malformed job" });
	assert.deepEqual(await skip({ ...w.job, projectDir: path.join(w.root, "gone") }), {
		outcome: "skipped",
		reason: "the session's project directory is gone",
	});
	await assert.rejects(w.recorded(), { code: "ENOENT" }, "claude ran for a skipped job");

	const blocked = await world(t, "ok", [
		entry.prompt("task"),
		entry.text("Done."),
		entry.prompt("Stop hook feedback: run the tests", { isMeta: true }),
		entry.summary(),
	]);
	assert.deepEqual(await captureTurn(blocked.job, { env: blocked.env }), { outcome: "skipped", reason: "a Stop hook continued the turn" });
	await assert.rejects(blocked.recorded(), { code: "ENOENT" }, "claude ran for a turn that went on");
});

test("captureTurn stops waiting for the turn to end once aborted", async (t) => {
	const w = await world(t, "ok", turnWithToolCalls(5));
	const record = await captureTurn(w.job, { env: w.env, signal: AbortSignal.abort("the session ended") });
	assert.deepEqual(record, { outcome: "aborted", reason: "the session ended" });
	await assert.rejects(w.recorded(), { code: "ENOENT" });
});

const queued = (start, end) => ({ sessionId: "s1", transcriptPath: "/t", start, end, projectDir: "/p" });

test("drainQueue runs each queued job oldest first, including one queued while it works", async (t) => {
	const dir = await tempDir(t);
	await queueCapture(dir, queued(10, 20));
	await queueCapture(dir, queued(0, 10));
	const seen = [];
	await drainQueue(dir, "s1", async (job) => {
		seen.push(job.end);
		if (seen.length === 1) await queueCapture(dir, queued(20, 30));
	});
	assert.deepEqual(seen, [10, 20, 30]);
	assert.equal(await takeJob(dir, "s1"), undefined);
	assert.ok(await acquireLock(dir, "s1"), "the lock was not released");
});

test("drainQueue leaves the queue to a live worker that holds the lock", async (t) => {
	const dir = await tempDir(t);
	assert.ok(await acquireLock(dir, "s1"));
	await queueCapture(dir, queued(0, 10));
	await drainQueue(dir, "s1", async () => assert.fail("ran a job while another worker held the lock"));
	assert.ok(await takeJob(dir, "s1"));
});

test("drainQueue takes no further job once aborted, and releases the lock", async (t) => {
	const dir = await tempDir(t);
	await queueCapture(dir, queued(0, 10));
	await queueCapture(dir, queued(10, 20));
	const controller = new AbortController();
	const seen = [];
	await drainQueue(
		dir,
		"s1",
		async (job) => {
			seen.push(job.end);
			controller.abort("the session ended");
		},
		controller.signal,
	);
	assert.deepEqual(seen, [10]);
	assert.equal((await takeJob(dir, "s1")).end, 20);
	assert.ok(await acquireLock(dir, "s1"), "the lock was not released");
});

/** Runs the worker script as the Stop hook does, and resolves once it exits. */
function runWorker(w) {
	return new Promise((resolve, reject) =>
		execFile(process.execPath, [WORKER_SCRIPT, "s1"], { env: w.env, cwd: w.env.CLAUDE_PLUGIN_DATA, timeout: 30_000 }, (error) =>
			error ? reject(error) : resolve(),
		),
	);
}

async function queueOneCapture(w) {
	await writeSessionState(w.env.CLAUDE_PLUGIN_DATA, "s1", { offset: 0, toolCalls: 0 });
	await queueCapture(w.env.CLAUDE_PLUGIN_DATA, w.job);
}

const readLog = (w) => fs.readFile(path.join(w.env.CLAUDE_PLUGIN_DATA, "auto-learn.log"), "utf8");
const lastRecord = async (w) => JSON.parse((await readLog(w)).trim().split("\n").at(-1));

test("the worker script captures the queued turn and logs what the capture did, without transcript text", async (t) => {
	const w = await world(t, "create");
	await queueOneCapture(w);
	await runWorker(w);
	const record = await lastRecord(w);
	assert.equal(record.event, "capture");
	assert.equal(record.session, "s1");
	assert.equal(record.outcome, "ok");
	assert.deepEqual(record.created, ["fake-skill"]);
	assert.doesNotMatch(await readLog(w), /dev database|step \d|Done: the database/, "the log must not hold transcript text");
});

test("the worker script stops a running capture once the session ends", async (t) => {
	const w = await world(t, "hang");
	await queueOneCapture(w);
	const exited = runWorker(w);
	await waitForFile(w.record);
	await forgetSession(w.env.CLAUDE_PLUGIN_DATA, "s1");
	await exited;
	const record = await lastRecord(w);
	assert.equal(record.outcome, "aborted");
	assert.equal(record.reason, "the session ended");
});
