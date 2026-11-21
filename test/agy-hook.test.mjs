import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runHook } from "../scripts/lib/hook.mjs";
import { manageSkill } from "../scripts/lib/skills.mjs";
import { readSessionState, takeJob, writeSessionState } from "../scripts/lib/state.mjs";
import { AGY_CONVERSATION as SESSION, agy, agyTurn, runUnderAgy, tempDir, toJsonl } from "./helpers.mjs";

const HOOK_SCRIPT = new URL("../scripts/hook.mjs", import.meta.url).pathname;
const PROMPT = "Set up the dev database";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An Antigravity CLI conversation: the hook runs with --host=agy and reads the
 * conversation's transcript in `store` under ~/.gemini. `isAttended` stands in
 * for the look at the process tree that tells a terminal from a script run.
 */
async function agySession(t, { env: extraEnv = {}, isAttended = async () => true, store = "antigravity-cli" } = {}) {
	const root = await tempDir(t);
	const home = path.join(root, "home");
	const env = {
		HOME: home,
		PLUGIN_DATA: path.join(root, "data"),
		AUTO_LEARN_SKILLS_DIR: path.join(root, "skills"),
		CLAUDE_CONFIG_DIR: path.join(root, "config"),
		...extraEnv,
	};
	const logs = path.join(home, ".gemini", store, "brain", SESSION, ".system_generated", "logs");
	await fs.mkdir(logs, { recursive: true });
	const transcriptPath = path.join(logs, "transcript_full.jsonl");
	await fs.writeFile(transcriptPath, "");
	const workers = [];
	const workerEnvs = [];
	const run = (event, input = {}) =>
		runHook(
			event,
			{
				conversationId: SESSION,
				transcriptPath,
				cwd: "/work/elsewhere",
				workspacePaths: ["/work/project"],
				lastUserInput: PROMPT,
				...(event === "stop" ? { fullyIdle: true, terminationReason: "NO_TOOL_CALL" } : {}),
				...input,
			},
			{
				env,
				host: "agy",
				isAttended,
				spawnWorker: async (sessionId, workerEnv, host) => {
					workers.push([sessionId, host]);
					workerEnvs.push(workerEnv);
				},
			},
		);
	const log = async () => {
		try {
			return (await fs.readFile(path.join(env.PLUGIN_DATA, "auto-learn.log"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => {
					const { time, ...record } = JSON.parse(line);
					assert.equal(typeof time, "string");
					return record;
				});
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
	};
	return {
		home,
		env,
		transcriptPath,
		workers,
		workerEnvs,
		run,
		log,
		append: (records) => fs.appendFile(transcriptPath, toJsonl(records)),
		size: async () => (await fs.stat(transcriptPath)).size,
		state: () => readSessionState(env.PLUGIN_DATA, SESSION),
		job: () => takeJob(env.PLUGIN_DATA, SESSION),
		skips: async () => (await log()).map(({ event, reason, toolCalls }) => [event, reason, toolCalls]),
	};
}

/** Runs hook.mjs as agy does, with `input` on stdin; `env` is all it gets besides what the test runner has. */
function runScript(args, input, env) {
	const base = { ...process.env };
	delete base.AUTO_LEARN_CAPTURE;
	return new Promise((resolve) => {
		const child = execFile(process.execPath, [HOOK_SCRIPT, ...args], { env: { ...base, ...env } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
		child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
	});
}

test("agy session start adds the guidance and the learned skills as a system message, and saves where the session starts", async (t) => {
	const s = await agySession(t);
	await manageSkill({ action: "create", name: "deploy-docs", description: "Use when publishing the docs", body: "1. Run it." }, { skillsDir: s.env.AUTO_LEARN_SKILLS_DIR });
	const output = await s.run("session-start");
	assert.deepEqual(Object.keys(output), ["injectSteps"]);
	assert.equal(output.injectSteps.length, 1);
	assert.deepEqual(Object.keys(output.injectSteps[0]), ["systemMessage"]);
	assert.deepEqual(Object.keys(output.injectSteps[0].systemMessage), ["systemMessage"]);
	const text = output.injectSteps[0].systemMessage.systemMessage;
	assert.match(text, /^# Skill library\n/);
	assert.match(text, /Antigravity offers a saved skill/);
	assert.doesNotMatch(text, /Claude|Codex|Copilot/);
	assert.match(text, /\n## Learned skills\n[\s\S]*\n- deploy-docs: Use when publishing the docs$/);
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });
});

test("agy session start forgets the states of sessions last used over 30 days ago, which no session-end hook removes", async (t) => {
	const s = await agySession(t);
	const age = async (name, days) => {
		await writeSessionState(s.env.PLUGIN_DATA, name, { offset: 5, toolCalls: 1 });
		const when = new Date(Date.now() - days * DAY_MS);
		await fs.utimes(path.join(s.env.PLUGIN_DATA, "sessions", `${name}.json`), when, when);
	};
	await age("old-session", 30.5);
	await age("recent-session", 29.5);
	await s.run("session-start");
	assert.equal(await readSessionState(s.env.PLUGIN_DATA, "old-session"), undefined);
	assert.deepEqual(await readSessionState(s.env.PLUGIN_DATA, "recent-session"), { offset: 5, toolCalls: 1 });
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });
});

test("a conversation of the Antigravity IDE or app, or a hook input with no usable transcriptPath, gets nothing from either hook", async (t) => {
	const s = await agySession(t);
	await s.append(agyTurn(0, 5));
	const elsewhere = [
		path.join(s.home, ".gemini", "antigravity-ide", "brain", SESSION, ".system_generated", "logs", "transcript_full.jsonl"),
		path.join(s.home, ".gemini", "antigravity", "brain", SESSION, ".system_generated", "logs", "transcript_full.jsonl"),
		path.join(s.home, ".gemini", "antigravity-cli-x", "brain", SESSION, ".system_generated", "logs", "transcript_full.jsonl"),
		"transcript_full.jsonl",
		"",
		undefined,
	];
	for (const transcriptPath of elsewhere) {
		for (const event of ["session-start", "stop"]) assert.equal(await s.run(event, { transcriptPath }), undefined, `${event} ${transcriptPath}`);
	}
	assert.deepEqual(s.workers, []);
	await assert.rejects(fs.access(s.env.PLUGIN_DATA), { code: "ENOENT" }, "nothing is written for a conversation that is not the CLI's");
});

test("an agy turn with enough tool calls queues a capture of the turn and starts the worker for it", async (t) => {
	const s = await agySession(t);
	await s.run("session-start");
	await s.append(agyTurn(0, 5));
	assert.equal(await s.run("stop"), undefined);

	assert.deepEqual(s.workers, [[SESSION, "agy"]]);
	// The worker needs the hook's environment: its HOME and options decide where it reads and what it reviews.
	assert.deepEqual(s.workerEnvs, [s.env]);
	assert.deepEqual(await s.job(), { host: "agy", sessionId: SESSION, transcriptPath: s.transcriptPath, start: 0, end: await s.size(), toolCalls: 5, projectDir: "/work/project" });
	assert.deepEqual(await s.state(), { offset: 0, promptId: "0", toolCalls: 5, queued: true });
	assert.deepEqual(await s.log(), [{ event: "queued", session: SESSION, toolCalls: 5, terminationReason: "NO_TOOL_CALL" }]);
});

test("a prompt that mentions /plan after its first word is no plan", async (t) => {
	const s = await agySession(t);
	await s.run("session-start");
	await s.append(agyTurn(0, 5));
	await s.run("stop", { lastUserInput: "what does /plan do in agy?" });
	assert.deepEqual(s.workers, [[SESSION, "agy"]]);
});

test("a second stop in a turn that is already queued is skipped, however much the turn has grown, and a new user turn is queued again", async (t) => {
	const s = await agySession(t);
	await s.run("session-start");
	await s.append(agyTurn(0, 5));
	await s.run("stop");
	await s.job();

	// A subagent's report makes the model carry on in the same turn.
	await s.append([agy.reply(12, { calls: [agy.call("run_command", { CommandLine: "more" })] }), agy.result(13, "Command exited with code 0."), agy.reply(14, { content: "Done." })]);
	await s.run("stop");
	assert.deepEqual(s.workers, [[SESSION, "agy"]]);
	assert.equal(await s.job(), undefined);
	assert.deepEqual(await s.state(), { offset: 0, promptId: "0", toolCalls: 5, queued: true });
	assert.deepEqual(await s.skips(), [["queued", undefined, 5], ["skip", "already queued", 6]]);

	const secondStart = await s.size();
	await s.append(agyTurn(15, 5, "Fix the migration"));
	await s.run("stop", { lastUserInput: "Fix the migration" });
	assert.deepEqual(s.workers, [[SESSION, "agy"], [SESSION, "agy"]]);
	assert.deepEqual(await s.job(), { host: "agy", sessionId: SESSION, transcriptPath: s.transcriptPath, start: secondStart, end: await s.size(), toolCalls: 5, projectDir: "/work/project" });
	assert.deepEqual(await s.state(), { offset: secondStart, promptId: "15", toolCalls: 5, queued: true });
});

test("an agy stop that is no turn to review queues nothing, and logs why where a person would want to know", async (t) => {
	const started = { offset: 0, toolCalls: 0 };
	const cases = [
		["too few tool calls", {}, { calls: 4 }, [["skip", "fewer than 5 tool calls", 4]], { offset: 0, promptId: "0", toolCalls: 4 }],
		["plan mode", {}, { input: { lastUserInput: `/plan ${PROMPT}` } }, [["skip", "plan mode", 5]], { offset: 0, promptId: "0", toolCalls: 5 }],
		["plan mode with nothing typed after /plan", {}, { input: { lastUserInput: "/plan" } }, [["skip", "plan mode", 5]], { offset: 0, promptId: "0", toolCalls: 5 }],
		["a subagent's stop, which has no user input", {}, { input: { lastUserInput: "" } }, [], started],
		["a stop with no user input at all", {}, { input: { lastUserInput: undefined } }, [], started],
		["a stop while a subagent still runs", {}, { input: { fullyIdle: false } }, [], started],
		["a review's own session", { env: { AUTO_LEARN_CAPTURE: "1" } }, {}, [], undefined],
		["autoCapture off", { env: { CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "false" } }, {}, [], started],
		["a script run", { isAttended: async () => false }, {}, [["skip", "unattended session", undefined]], started],
		["a session that cannot be classified", { isAttended: async () => undefined }, {}, [["skip", "unattended session", undefined]], started],
	];
	for (const [name, session, { calls = 5, input }, skips, state] of cases) {
		const s = await agySession(t, session);
		await s.run("session-start");
		await s.append(agyTurn(0, calls));
		await s.run("stop", input);
		assert.deepEqual(s.workers, [], name);
		assert.equal(await s.job(), undefined, name);
		assert.deepEqual(await s.skips(), skips, name);
		assert.deepEqual(await s.state(), state, name);
	}
});

test("a turn that used a subagent is queued once, at the stop that the subagent's report provokes in the main conversation", async (t) => {
	const s = await agySession(t);
	await s.run("session-start");
	await s.append(agyTurn(0, 5));
	await s.run("stop", { fullyIdle: false });
	await s.run("stop", { lastUserInput: "" });
	assert.deepEqual(s.workers, []);
	assert.deepEqual(await s.log(), []);

	await s.run("stop");
	assert.deepEqual(s.workers, [[SESSION, "agy"]]);
	assert.equal((await s.job()).toolCalls, 5);
	assert.equal(await s.job(), undefined);
});

test("a turn that reaches the minimum at a later stop is queued then, and a prompt that only starts like /plan is no plan", async (t) => {
	const s = await agySession(t);
	await s.run("session-start");
	await s.append(agyTurn(0, 4));
	await s.run("stop");
	assert.deepEqual(s.workers, []);
	assert.deepEqual(await s.state(), { offset: 0, promptId: "0", toolCalls: 4 });

	await s.append([agy.reply(10, { calls: [agy.call("run_command", { CommandLine: "one more" })] }), agy.result(11, "Command exited with code 0."), agy.reply(12, { content: "Done." })]);
	await s.run("stop", { lastUserInput: "/planning the day" });
	assert.deepEqual(s.workers, [[SESSION, "agy"]]);
	assert.deepEqual(await s.job(), { host: "agy", sessionId: SESSION, transcriptPath: s.transcriptPath, start: 0, end: await s.size(), toolCalls: 5, projectDir: "/work/project" });
	assert.deepEqual(await s.skips(), [["skip", "fewer than 5 tool calls", 4], ["queued", undefined, 5]]);
});

test("a stop that does not say whether agy is idle is taken as idle, and one before the transcript holds a prompt is skipped and looked at again", async (t) => {
	const s = await agySession(t);
	await s.run("session-start");
	await s.run("stop");
	assert.deepEqual(s.workers, []);
	assert.deepEqual(await s.skips(), [["skip", "the transcript has no turn", undefined]]);
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });

	await s.append(agyTurn(0, 5));
	await s.run("stop", { fullyIdle: undefined });
	assert.deepEqual(s.workers, [[SESSION, "agy"]]);
});

test("a corrupt session state, or one past the end of the transcript, is replaced after a scan from the start", async (t) => {
	for (const damage of [(file) => fs.writeFile(file, "{not json"), (file, size) => fs.writeFile(file, JSON.stringify({ offset: size + 1000, toolCalls: 3 }))]) {
		const s = await agySession(t);
		await s.run("session-start");
		await s.append(agyTurn(0, 5));
		await damage(path.join(s.env.PLUGIN_DATA, "sessions", `${SESSION}.json`), await s.size());
		await s.run("stop");
		assert.deepEqual(s.workers, [[SESSION, "agy"]]);
		assert.equal((await s.job()).start, 0);
		assert.deepEqual(await s.state(), { offset: 0, promptId: "0", toolCalls: 5, queued: true });
	}
});

test("the capture runs in the first workspace folder, else in the hook's working directory", async (t) => {
	for (const [workspacePaths, projectDir] of [
		[["/work/project", "/work/other"], "/work/project"],
		[[], "/work/elsewhere"],
		[undefined, "/work/elsewhere"],
		[[""], "/work/elsewhere"],
	]) {
		const s = await agySession(t);
		await s.run("session-start");
		await s.append(agyTurn(0, 5));
		await s.run("stop", { workspacePaths });
		assert.equal((await s.job()).projectDir, projectDir, JSON.stringify(workspacePaths));
	}
});

test("a stop with neither a workspace folder nor a working directory fails, and leaves the turn for the next stop", async (t) => {
	const s = await agySession(t);
	await s.run("session-start");
	await s.append(agyTurn(0, 5));
	await assert.rejects(s.run("stop", { workspacePaths: [], cwd: undefined }), /The hook input has no usable workspacePaths or cwd\./);
	assert.deepEqual(s.workers, []);
	assert.equal(await s.job(), undefined);
	assert.deepEqual(await s.state(), { offset: 0, toolCalls: 0 });
});

test("agy hooks read the conversationId that agy sends, and refuse input without a usable one", async (t) => {
	const s = await agySession(t);
	await assert.rejects(s.run("session-start", { conversationId: undefined, session_id: SESSION }), /The hook input has no usable conversationId: undefined\./);
	await assert.rejects(s.run("stop", { conversationId: "../s1" }), /The hook input has no usable conversationId: "\.\.\/s1"\./);
	await assert.rejects(s.run("other"), /Unknown hook event "other"/);
});

test("the hook script prints {} when agy's hook has nothing to say, and fails on stderr alone when it cannot read its input", async (t) => {
	const ide = await agySession(t, { store: "antigravity-ide" });
	const input = { conversationId: SESSION, transcriptPath: ide.transcriptPath, cwd: "/work/project", lastUserInput: PROMPT };
	for (const event of ["session-start", "stop"]) assert.deepEqual(await runScript([event, "--host=agy"], input, ide.env), { code: 0, stdout: "{}\n", stderr: "" }, event);

	const cli = await agySession(t);
	const started = await runScript(["session-start", "--host=agy"], { ...input, transcriptPath: cli.transcriptPath }, cli.env);
	assert.equal(started.code, 0);
	assert.equal(started.stderr, "");
	assert.match(JSON.parse(started.stdout).injectSteps[0].systemMessage.systemMessage, /^# Skill library\n/);

	const review = await agySession(t);
	assert.deepEqual(await runScript(["session-start", "--host=agy"], { ...input, transcriptPath: review.transcriptPath }, { ...review.env, AUTO_LEARN_CAPTURE: "1" }), { code: 0, stdout: "{}\n", stderr: "" });
	assert.equal(await review.state(), undefined);

	const broken = await runScript(["stop", "--host=agy"], "not json", cli.env);
	assert.equal(broken.code, 1);
	assert.equal(broken.stdout, "");
	assert.equal(broken.stderr, "auto-learn: The hook input is not valid JSON.\n");
});

test("run by a script run of agy (agy -p), the Stop hook reviews nothing and says why; the session start still adds its guidance", { skip: !existsSync("/proc/self/stat") && "no /proc" }, async (t) => {
	const s = await agySession(t);
	await s.append(agyTurn(0, 5));
	const input = { conversationId: SESSION, transcriptPath: s.transcriptPath, cwd: "/work/project", workspacePaths: ["/work/project"], lastUserInput: PROMPT, fullyIdle: true };
	assert.deepEqual(await runUnderAgy(["-p"], [HOOK_SCRIPT, "stop", "--host=agy"], input, s.env), { code: 0, stdout: "{}\n", stderr: "" });
	assert.equal(await s.job(), undefined);
	assert.deepEqual(await s.skips(), [["skip", "unattended session", undefined]]);

	const started = await runUnderAgy(["-p"], [HOOK_SCRIPT, "session-start", "--host=agy"], input, s.env);
	assert.equal(started.code, 0);
	assert.match(JSON.parse(started.stdout).injectSteps[0].systemMessage.systemMessage, /^# Skill library\n/);
});
