import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { captureAgyTurn, runAgyReview } from "../scripts/lib/agy.mjs";
import { captureNudge } from "../scripts/lib/prompts.mjs";
import { MARKER_FILE } from "../scripts/lib/skills.mjs";
import { hasJob, queueCapture } from "../scripts/lib/state.mjs";
import { AGY_CONVERSATION, agy, agyTurn, runUnderAgy, tempDir, toJsonl } from "./helpers.mjs";

const FAKE_AGY = new URL("./fake-agy.mjs", import.meta.url).pathname;
const WORKER_SCRIPT = new URL("../scripts/capture.mjs", import.meta.url).pathname;
const HOOK_SCRIPT = new URL("../scripts/hook.mjs", import.meta.url).pathname;
const PROMPT = "Set up the dev database";
const OTHER_CONVERSATION = "7c1f0a52-91d4-4e0b-8a3c-5d6e7f8091a2";
const OLD_CONVERSATION = "11111111-2222-4333-8444-555555555555";
// What agy and Claude Code add to the environment of the session's hooks, and what the user's options become.
const HOOK_ENV = {
	ANTIGRAVITY_CONVERSATION_ID: AGY_CONVERSATION,
	CLAUDECODE: "1",
	CLAUDE_CODE_ENTRYPOINT: "cli",
	CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "true",
	CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "5",
	PLUGIN_ROOT: "/plugin",
};
const REVIEW_ARGS = [
	"-p",
	"",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--agent",
	"auto-learn-review",
	"--print-timeout",
	"240s",
	"--settings",
	'{"toolPermission":"always-proceed"}',
	"--disable-slash-commands",
	"--app_data_dir=auto-learn-review",
];
const EMPTY_STORE = { brain: [], conversations: [], presence: [] };
// What the fake's ok review reports: its two replies read 2,600 and 4,100 tokens, 2,500 of them from the cache, and wrote 55.
const OK_TOKENS = { inputTokens: 6600, cacheReadTokens: 2500, outputTokens: 55 };

async function listing(dir) {
	try {
		return (await fs.readdir(dir)).sort();
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

/** Whether `pid` is a running process; a killed one that nobody has collected yet is not. */
function isRunning(pid) {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
	try {
		return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		// Without /proc the signal check above is all there is.
		return true;
	}
}

function killQuietly(pid) {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone, as it should be.
	}
}

/** Waits a moment for `pid` to be reaped, since a killed process is gone only once its new parent has collected it. */
async function assertGone(pid) {
	const deadline = Date.now() + 3000;
	while (isRunning(pid) && Date.now() < deadline) await sleep(20);
	assert.equal(isRunning(pid), false, "what the review started outlived it");
}

/** The log record of the first capture a worker finished, once it has, and once the worker has let go of the session's lock. */
async function captured(env, sessionId) {
	const log = path.join(env.PLUGIN_DATA, "auto-learn.log");
	const deadline = Date.now() + 15_000;
	for (;;) {
		let found;
		try {
			found = (await fs.readFile(log, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find((record) => record.event === "capture");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (found && (await listing(path.join(env.PLUGIN_DATA, "locks"))).length === 0) return found;
		assert.ok(Date.now() < deadline, `the worker for ${sessionId} never logged a capture`);
		await sleep(50);
	}
}

/**
 * A temporary world: a fake agy on PATH, a HOME with the conversation whose
 * transcript holds `turn`, the project, the plugin's data folder and a skills
 * folder. `env` is what the worker inherits from the hook that started it.
 */
async function world(t, mode, { turn = agyTurn(0, 5, PROMPT), env: extraEnv = {}, job: jobFields = {} } = {}) {
	const root = await tempDir(t);
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	await fs.writeFile(path.join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`, { mode: 0o755 });
	const home = path.join(root, "home");
	const record = path.join(root, "record.jsonl");
	const env = {
		...process.env,
		...HOOK_ENV,
		HOME: home,
		CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
		PATH: `${bin}${path.delimiter}${process.env.PATH}`,
		PLUGIN_DATA: path.join(root, "data"),
		AUTO_LEARN_SKILLS_DIR: path.join(root, "skills"),
		FAKE_AGY_MODE: mode,
		FAKE_AGY_RECORD: record,
		FAKE_AGY_MARKER: path.join(root, "marker"),
		...extraEnv,
	};
	delete env.AUTO_LEARN_CAPTURE;
	const projectDir = path.join(root, "project");
	await fs.mkdir(projectDir);
	const transcriptDir = path.join(home, ".gemini", "antigravity-cli", "brain", AGY_CONVERSATION, ".system_generated", "logs");
	await fs.mkdir(transcriptDir, { recursive: true });
	const transcriptPath = path.join(transcriptDir, "transcript_full.jsonl");
	await fs.writeFile(transcriptPath, toJsonl(turn));
	const end = (await fs.stat(transcriptPath)).size;
	const job = { host: "agy", sessionId: AGY_CONVERSATION, transcriptPath, start: 0, end, toolCalls: 5, projectDir, ...jobFields };
	const recorded = async () => {
		try {
			return (await fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
	};
	const store = path.join(home, ".gemini", "auto-learn-review");
	return {
		root,
		home,
		env,
		job,
		store,
		recorded,
		review: async () => (await recorded()).find((entry) => entry.args),
		/** The entries of the review store's conversation folders. */
		stored: async () => ({ brain: await listing(path.join(store, "brain")), conversations: await listing(path.join(store, "conversations")), presence: await listing(path.join(store, "presence")) }),
		/** The first line the fake recorded that `predicate` accepts, once it has. */
		until: async (predicate) => {
			const deadline = Date.now() + 10_000;
			for (;;) {
				const found = (await recorded()).find(predicate);
				if (found) return found;
				assert.ok(Date.now() < deadline, "the fake agy never got there");
				await sleep(20);
			}
		},
	};
}

const capture = (w, options) => captureAgyTurn(w.job, { env: w.env, ...options });
const withoutDuration = ({ durationMs, ...record }) => {
	assert.equal(typeof durationMs, "number");
	return record;
};

async function saveSkill(dir, name, description) {
	await fs.mkdir(path.join(dir, name), { recursive: true });
	await fs.writeFile(path.join(dir, name, MARKER_FILE), "");
	await fs.writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n1. A step.\n`);
}

test("a review runs agy with the review command line, in the plugin's review workspace", async (t) => {
	const w = await world(t, "ok");
	await capture(w);
	const run = await w.review();
	assert.deepEqual(run.args, REVIEW_ARGS);
	const workspace = path.join(w.env.PLUGIN_DATA, "review-workspace");
	assert.equal(await fs.realpath(run.cwd), await fs.realpath(workspace));
	assert.equal((await fs.stat(workspace)).mode & 0o777, 0o700);
});

test("the prompt is one stream-json message: the excerpt between nonce markers, then the request with the skills saved so far", async (t) => {
	const w = await world(t, "ok");
	await capture(w);
	await saveSkill(w.env.AUTO_LEARN_SKILLS_DIR, "earlier-skill", "Use when the earlier thing happens.");
	await capture(w);
	const [first, second] = (await w.recorded()).map((entry) => entry.stdin);
	const parse = (stdin) => {
		const lines = stdin.split("\n");
		assert.equal(lines.length, 2, "one line, ended by a newline");
		assert.equal(lines[1], "");
		const message = JSON.parse(lines[0]);
		assert.deepEqual(Object.keys(message).sort(), ["event", "message"]);
		assert.equal(message.event, "user");
		assert.equal(message.message.content.length, 1);
		assert.equal(message.message.content[0].type, "text");
		const match = /^\[auto-learn review\]\n\nBEGIN EXCERPT ([0-9a-f]{16})\n([^]*)\nEND EXCERPT \1\n\n([^]*)$/.exec(message.message.content[0].text);
		assert.ok(match, "the prompt has the shape review prompts have");
		return { nonce: match[1], excerpt: match[2], request: match[3] };
	};
	const one = parse(first);
	assert.ok(one.excerpt.startsWith(`[user]\n${PROMPT}\n\n[tool call] run_command\n{"CommandLine":"step 1"}`), one.excerpt);
	assert.ok(one.excerpt.includes('[tool call] run_command\n{"CommandLine":"step 5"}\n\n[tool result]\nCommand exited with code 0.\n\nCommand output:\nok 5'), one.excerpt);
	assert.ok(one.excerpt.endsWith("[assistant]\nDone: the database is ready."), one.excerpt);
	assert.equal(one.request, captureNudge("manage_skill", "agy", { skills: "none yet", nonce: one.nonce }));
	const two = parse(second);
	assert.equal(two.request, captureNudge("manage_skill", "agy", { skills: "- earlier-skill: Use when the earlier thing happens.", nonce: two.nonce }));
	assert.notEqual(one.nonce, two.nonce, "every review gets a nonce of its own");
});

test("the review's environment drops what agy and Claude Code tell the session's hooks, and tells the review's tool where the project is", async (t) => {
	const w = await world(t, "ok");
	await capture(w);
	const { env } = await w.review();
	for (const name of Object.keys(HOOK_ENV).concat("PLUGIN_DATA")) assert.equal(env[name], undefined, `${name} reached the review`);
	assert.equal(env.AUTO_LEARN_CAPTURE, "1");
	assert.equal(env.AUTO_LEARN_PROJECT_DIR, w.job.projectDir);
	assert.equal(env.HOME, w.home);
	assert.equal(env.PATH, w.env.PATH);
});

test("a review that saves a skill is ok, reports what it saved and used, and leaves nothing in the review store", async (t) => {
	const w = await world(t, "ok");
	assert.deepEqual(withoutDuration(await capture(w)), {
		outcome: "ok",
		deniedActions: 0,
		skillCalls: 1,
		otherToolCalls: 0,
		otherTools: [],
		...OK_TOKENS,
		created: ["fake-skill"],
		updated: [],
		deleted: [],
	});
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});

test("a review whose manage_skill is an eager tool, as the plugin's own config makes it, is not stopped, and its save counts", async (t) => {
	const w = await world(t, "ok", { env: { FAKE_AGY_EAGER: "1" } });
	assert.deepEqual(withoutDuration(await capture(w)), {
		outcome: "ok",
		deniedActions: 0,
		skillCalls: 1,
		otherToolCalls: 0,
		otherTools: [],
		...OK_TOKENS,
		created: ["fake-skill"],
		updated: [],
		deleted: [],
	});
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});

test("a review whose calls agy denied is an error that saved nothing, and its conversation is removed", async (t) => {
	const plural = withoutDuration(await capture(await world(t, "refused", { env: { FAKE_AGY_DENIED: "2" } })));
	assert.equal(plural.error, "agy denied 2 actions");
	assert.equal(plural.deniedActions, 2);
	const w = await world(t, "refused");
	assert.deepEqual(withoutDuration(await capture(w)), {
		outcome: "error",
		error: "agy denied 1 action",
		deniedActions: 1,
		skillCalls: 1,
		otherToolCalls: 0,
		otherTools: [],
		...OK_TOKENS,
		created: [],
		updated: [],
		deleted: [],
	});
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});

test("a review that agy ends with an error result reports agy's reason, or its status when it gives none", async (t) => {
	const nothing = { deniedActions: 0, skillCalls: 0, otherToolCalls: 0, otherTools: [], inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, created: [], updated: [], deleted: [] };
	const failures = [
		[{ status: "ERROR", error: "No model is available for this request.", finished_reason: "ERROR" }, { error: "No model is available for this request.", finishedReason: "ERROR" }],
		[{ status: "CANCELLED" }, { error: "agy ended with the status CANCELLED" }],
	];
	for (const [printed, expected] of failures) {
		const w = await world(t, "failed", { env: { FAKE_AGY_RESULT: JSON.stringify(printed) } });
		assert.deepEqual(withoutDuration(await capture(w)), { outcome: "error", ...expected, ...nothing });
		assert.deepEqual(await w.stored(), EMPTY_STORE);
	}
});

test("an agy that exits without a result is an error with the end of its stderr, and there is no conversation to remove", async (t) => {
	const w = await world(t, "exit");
	const record = withoutDuration(await capture(w));
	assert.equal(record.outcome, "error");
	assert.equal(record.error, "agy ended without a result (exit 3): Error: not signed in. Run agy and sign in first.");
	assert.equal(record.cleanupError, undefined);
	const long = withoutDuration(await capture(await world(t, "exit", { env: { FAKE_AGY_STDERR: `${"progress ".repeat(300)}\nError: out of quota.\n` } })));
	assert.ok(long.error.startsWith("agy ended without a result (exit 3): "), long.error);
	assert.ok(long.error.endsWith("progress \nError: out of quota."), long.error);
	assert.ok(long.error.length < 600, "the error is bounded");
	const silent = withoutDuration(await capture(await world(t, "exit", { env: { FAKE_AGY_STDERR: "" } })));
	assert.equal(silent.error, "agy ended without a result (exit 3): no error output");
});

test("an agy that a signal kills is an error that names the signal, and its conversation is removed", async (t) => {
	const w = await world(t, "crash");
	const record = withoutDuration(await capture(w));
	assert.equal(record.outcome, "error");
	assert.equal(record.error, "agy ended without a result (exit SIGKILL): no error output");
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});

test("without agy on PATH the review is an error that says so", async (t) => {
	const w = await world(t, "ok");
	const record = withoutDuration(await capture(w, { env: { ...w.env, PATH: path.join(w.root, "bin-empty") } }));
	assert.equal(record.outcome, "error");
	assert.equal(record.error, "the agy CLI was not found on PATH");
	assert.deepEqual(await w.recorded(), [], "agy must not run");
});

test("captureAgyTurn skips a malformed job, a gone transcript, an emptied turn and a gone project, and stops once aborted, without running agy", async (t) => {
	const w = await world(t, "ok");
	const malformed = [
		{ ...w.job, sessionId: "../s1" },
		{ ...w.job, transcriptPath: "transcript_full.jsonl" },
		{ ...w.job, start: -1 },
		{ ...w.job, start: 0.5 },
		{ ...w.job, start: w.job.end + 1 },
		{ ...w.job, end: 1.5 },
		{ ...w.job, end: String(w.job.end) },
		{ ...w.job, projectDir: "" },
		{ ...w.job, projectDir: undefined },
		undefined,
	];
	for (const job of malformed) assert.deepEqual(await captureAgyTurn(job, { env: w.env }), { outcome: "skipped", reason: "malformed job" });
	assert.deepEqual(await capture(w, { signal: AbortSignal.abort("the session ended") }), { outcome: "aborted", reason: "the session ended" });
	assert.deepEqual(await captureAgyTurn({ ...w.job, transcriptPath: path.join(w.root, "gone.jsonl") }, { env: w.env }), { outcome: "skipped", reason: "the conversation's transcript is gone" });
	const quiet = await world(t, "ok", { turn: [agy.system(0, "Only a system message.")] });
	assert.deepEqual(await capture(quiet), { outcome: "skipped", reason: "the turn is no longer in the transcript" });
	await fs.rm(w.job.projectDir, { recursive: true });
	assert.deepEqual(await capture(w), { outcome: "skipped", reason: "the session's project directory is gone" });
	for (const each of [w, quiet]) assert.deepEqual(await each.recorded(), [], "agy must not run");
});

test("a review that calls a tool other than manage_skill is stopped at once, and its conversation is removed", { timeout: 30000 }, async (t) => {
	const w = await world(t, "rogue");
	const started = Date.now();
	assert.deepEqual(withoutDuration(await capture(w)), {
		outcome: "stopped",
		reason: "the review called a tool other than manage_skill",
		stoppedTool: "run_command",
		deniedActions: 0,
		skillCalls: 0,
		otherToolCalls: 0,
		otherTools: [],
		inputTokens: 0,
		cacheReadTokens: 0,
		outputTokens: 0,
		created: [],
		updated: [],
		deleted: [],
	});
	// The fake carries on and writes its marker after 8 seconds unless it is stopped.
	assert.ok(Date.now() - started < 6000, "the review was stopped, not waited for");
	await assert.rejects(fs.access(w.env.FAKE_AGY_MARKER), { code: "ENOENT" });
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});

test("a review stopped at a foreign tool stays stopped when its signal aborts while it is still dying", { timeout: 30000 }, async (t) => {
	const w = await world(t, "rogue", { env: { FAKE_AGY_IGNORE_SIGTERM: "1" } });
	const controller = new AbortController();
	const pending = runAgyReview({ prompt: "x", cwd: w.root, env: w.env, signal: controller.signal, killGraceMs: 300 });
	// The fake records SIGTERM, which is sent when the foreign tool stops the review, and goes on.
	await w.until((entry) => entry.terminated);
	controller.abort("the session ended");
	const result = await pending;
	assert.equal(result.outcome, "stopped");
	assert.equal(result.reason, "the review called a tool other than manage_skill");
});

test("an aborted review is aborted, and its conversation is removed", { timeout: 30000 }, async (t) => {
	const w = await world(t, "hang");
	const controller = new AbortController();
	const pending = capture(w, { signal: controller.signal });
	await w.until((entry) => entry.ready);
	controller.abort("the session ended");
	const record = withoutDuration(await pending);
	assert.equal(record.outcome, "aborted");
	assert.equal(record.reason, "the session ended");
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});

test("runAgyReview ends a review that runs too long as a timeout, and one whose signal has already aborted as aborted", async (t) => {
	const w = await world(t, "hang");
	const result = await runAgyReview({ prompt: "x", cwd: w.root, env: w.env, timeoutMs: 400, killGraceMs: 300 });
	assert.equal(result.outcome, "timeout");
	assert.equal(result.error, undefined);
	const aborted = await runAgyReview({ prompt: "x", cwd: w.root, env: w.env, signal: AbortSignal.abort("the session ended"), killGraceMs: 300 });
	assert.equal(aborted.outcome, "aborted");
	assert.equal(aborted.reason, "the session ended");
});

test("runAgyReview reports an agy that exits without reading a prompt too large for the pipe, instead of failing on the broken pipe", async (t) => {
	const w = await world(t, "exit");
	const result = await runAgyReview({ prompt: "x".repeat(2_000_000), cwd: w.root, env: w.env });
	assert.equal(result.outcome, "error");
	assert.match(result.error, /^agy ended without a result \(exit 3\): /);
});

test("a review that exits when stopped is reported as stopped, whatever result it prints on the way out, and what it started dies with it", { timeout: 30000 }, async (t) => {
	const w = await world(t, "polite");
	const controller = new AbortController();
	const pending = runAgyReview({ prompt: "x", cwd: w.root, env: w.env, signal: controller.signal });
	const { grandchild } = await w.until((entry) => entry.grandchild);
	t.after(() => killQuietly(grandchild));
	controller.abort("the session ended");
	const result = await pending;
	assert.equal(result.outcome, "aborted");
	assert.equal(result.reason, "the session ended");
	assert.equal(result.summary.status, "ERROR", "the fake printed its result");
	await assertGone(grandchild);
});

test("runAgyReview kills a review that ignores SIGTERM, and everything it started, when the grace period ends", { timeout: 30000 }, async (t) => {
	const w = await world(t, "stubborn");
	const controller = new AbortController();
	const pending = runAgyReview({ prompt: "x", cwd: w.root, env: w.env, signal: controller.signal, killGraceMs: 300 });
	const { grandchild } = await w.until((entry) => entry.grandchild);
	t.after(() => killQuietly(grandchild));
	const started = Date.now();
	controller.abort("the session ended");
	assert.equal((await pending).outcome, "aborted");
	// The fake gives up by itself after 8 seconds, which is when a review that is never killed would end.
	assert.ok(Date.now() - started < 4000, "a review that ignores SIGTERM is killed when the grace period ends");
	await assertGone(grandchild);
});

test("a failure before agy runs is an error, and agy does not run", async (t) => {
	const w = await world(t, "ok");
	await fs.writeFile(path.join(w.root, "not-a-folder"), "");
	const record = withoutDuration(await capture(w, { env: { ...w.env, PLUGIN_DATA: path.join(w.root, "not-a-folder", "data") } }));
	assert.equal(record.outcome, "error");
	assert.match(record.error, /ENOTDIR|EEXIST/);
	assert.deepEqual(await w.recorded(), []);
});

test("a sweep of the review store that fails is reported, and the review still runs", async (t) => {
	const w = await world(t, "ok");
	await fs.mkdir(w.store, { recursive: true });
	await fs.writeFile(path.join(w.store, "log"), "");
	const record = withoutDuration(await capture(w));
	assert.equal(record.outcome, "ok");
	assert.equal(record.cleanupError, "could not read log: ENOTDIR");
	assert.deepEqual(record.created, ["fake-skill"]);
});

test("a conversation id that is no UUID is never used to name a path", async (t) => {
	const w = await world(t, "badid");
	const precious = path.join(w.home, ".gemini", "precious");
	const record = withoutDuration(await capture(w));
	assert.equal(record.outcome, "ok");
	assert.equal(record.cleanupError, "not a conversation id");
	await fs.access(path.join(precious, ".system_generated", "logs", "transcript_full.jsonl"));
	await fs.access(path.join(w.home, ".gemini", "precious.db"));
	await fs.access(path.join(w.home, ".gemini", "precious.lock"));
});

test("a review first sweeps the review store of conversations a crashed review left, and leaves the recent ones", async (t) => {
	const w = await world(t, "ok");
	const keep = async (id, ageMs) => {
		const files = [path.join(w.store, "brain", id, "step.txt"), path.join(w.store, "conversations", `${id}.db`)];
		for (const file of files) {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, "an earlier prompt");
		}
		// agy's conversation folder changes with the files in it, so its age is the folder's.
		const time = new Date(Date.now() - ageMs);
		for (const entry of [...files, path.join(w.store, "brain", id)]) await fs.utimes(entry, time, time);
	};
	await keep(OLD_CONVERSATION, 2 * 3_600_000);
	await keep(OTHER_CONVERSATION, 60_000);
	assert.equal((await capture(w)).outcome, "ok");
	assert.deepEqual(await w.stored(), { brain: [OTHER_CONVERSATION], conversations: [`${OTHER_CONVERSATION}.db`], presence: [] });
});

test("the record of a review holds none of the excerpt, the request, or where the review ran", async (t) => {
	for (const mode of ["ok", "refused", "failed", "exit", "rogue"]) {
		const w = await world(t, mode);
		const text = JSON.stringify(await capture(w));
		for (const secret of [PROMPT, "step 3", "[auto-learn review]", "BEGIN EXCERPT", "Automatic skill review", w.root, w.home]) assert.ok(!text.includes(secret), `${mode}: the record has ${JSON.stringify(secret)}`);
	}
});

test("the worker started with --host=agy reviews an agy job from agy's data directory, and has no session end to wait for", { timeout: 30000 }, async (t) => {
	// The fake takes 2 seconds, so a session watcher, which looks once a second and finds no saved state for the session, would abort the review.
	const w = await world(t, "ok", { env: { FAKE_AGY_DELAY: "2000" } });
	await queueCapture(w.env.PLUGIN_DATA, w.job);
	await new Promise((resolve, reject) => execFile(process.execPath, [WORKER_SCRIPT, w.job.sessionId, "--host=agy"], { env: w.env, cwd: w.root, timeout: 30_000 }, (error) => (error ? reject(error) : resolve())));
	const record = await captured(w.env, w.job.sessionId);
	assert.equal(record.session, w.job.sessionId);
	assert.equal(record.outcome, "ok");
	assert.deepEqual(record.created, ["fake-skill"]);
	assert.equal(await hasJob(w.env.PLUGIN_DATA, w.job.sessionId), false);
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});

test("a worker that gets SIGTERM while its review runs aborts the review, logs it as aborted and exits", { timeout: 30000 }, async (t) => {
	const w = await world(t, "hang");
	await queueCapture(w.env.PLUGIN_DATA, w.job);
	const worker = spawn(process.execPath, [WORKER_SCRIPT, w.job.sessionId, "--host=agy"], { env: w.env, cwd: w.root, stdio: "ignore" });
	t.after(() => worker.kill("SIGKILL"));
	const exited = new Promise((resolve) => worker.once("exit", resolve));
	await w.until((entry) => entry.args);
	worker.kill("SIGTERM");
	await exited;
	const record = await captured(w.env, w.job.sessionId);
	assert.equal(record.outcome, "aborted");
	assert.equal(record.reason, "the worker received SIGTERM");
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});

test("the Stop hook of an agy at a terminal queues the turn and starts a worker that reviews it", { timeout: 30000, skip: !existsSync("/proc/self/stat") && "no /proc" }, async (t) => {
	const w = await world(t, "ok");
	const input = { conversationId: AGY_CONVERSATION, transcriptPath: w.job.transcriptPath, cwd: w.job.projectDir, workspacePaths: [w.job.projectDir], lastUserInput: PROMPT, fullyIdle: true };
	// The hook runs as agy runs it, with agy as an ancestor that the hook finds out is no script run.
	assert.deepEqual(await runUnderAgy([], [HOOK_SCRIPT, "stop", "--host=agy"], input, w.env), { code: 0, stdout: "{}\n", stderr: "" });
	const record = await captured(w.env, AGY_CONVERSATION);
	assert.equal(record.session, AGY_CONVERSATION);
	assert.equal(record.outcome, "ok");
	assert.deepEqual(record.created, ["fake-skill"]);
	assert.equal(await hasJob(w.env.PLUGIN_DATA, AGY_CONVERSATION), false);
	assert.deepEqual(await w.stored(), EMPTY_STORE);
});
