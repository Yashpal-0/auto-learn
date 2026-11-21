// Stands in for the `agy` CLI in tests, for the headless review
// `agy -p "" --input-format stream-json --output-format stream-json ...`. It
// appends one JSON line to $FAKE_AGY_RECORD with its arguments, working
// directory, whole environment and the prompt it read from stdin, creates the
// files agy keeps for a conversation in the store `--app_data_dir` names under
// $HOME/.gemini, then reviews as $FAKE_AGY_MODE says:
//   ok        a junk line, then one manage_skill call that saves a skill, and a successful result, all
//             after $FAKE_AGY_DELAY milliseconds (default none) and once the file $FAKE_AGY_GATE exists, if
//             that is set; with $FAKE_AGY_EAGER set the call is reported as agy reports an eager tool
//   refused   a manage_skill call that agy denied: the call is DONE without output, the result lists
//             $FAKE_AGY_DENIED denials (default 1)
//   failed    the result in $FAKE_AGY_RESULT (JSON, default {"status":"ERROR"}) and exit status 3
//   exit      exit status 3 with $FAKE_AGY_STDERR on stderr (default a sign-in message), before reading the prompt
//   hang      prints its init, then never exits
//   stubborn  prints its init; ignores SIGTERM, as does a child it starts (recorded as {grandchild}); exits on its own after 8 seconds
//   polite    like hang, with a child that ignores SIGTERM (recorded as {grandchild}), but itself
//             prints a result with the status ERROR on SIGTERM and exits
//   rogue     a call of run_command, then idles until $FAKE_AGY_MARKER is written 8 seconds later; with
//             $FAKE_AGY_IGNORE_SIGTERM set it ignores SIGTERM and records it as {terminated: true}
//   stranger  an init that names another agent than the review's, then idles until $FAKE_AGY_MARKER is written 8 seconds later
//   crash     prints its init, then kills itself with SIGKILL
//   badid     a conversation id that is not a UUID but names a path outside the store
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGY_CONVERSATION, agyStream } from "./helpers.mjs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE;
const record = (entry) => appendFileSync(process.env.FAKE_AGY_RECORD, `${JSON.stringify(entry)}\n`);
const emit = (...events) => {
	for (const event of events.flat()) process.stdout.write(`${JSON.stringify(event)}\n`);
};
const idle = () => setInterval(() => {}, 1000);
const conversationId = mode === "badid" ? "../../precious" : AGY_CONVERSATION;

if (mode === "exit") {
	record({ args, cwd: process.cwd(), env: { ...process.env } });
	process.stderr.write(process.env.FAKE_AGY_STDERR ?? "Error: not signed in. Run agy and sign in first.\n");
	process.exit(3);
}

const stdin = await readStdin();
record({ args, cwd: process.cwd(), env: { ...process.env }, stdin, ppid: process.ppid });
keepConversation(stdin);
if (mode === "hang") hang();
else if (mode === "stubborn") stubborn();
else if (mode === "polite") polite();
else if (mode === "rogue") rogue();
else if (mode === "stranger") stranger();
else if (mode === "crash") crash();
else review();

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

/** What agy writes for a conversation, the prompt included, in the store `--app_data_dir=<name>` selects. */
function keepConversation(prompt) {
	const name = args.find((arg) => arg.startsWith("--app_data_dir="))?.slice("--app_data_dir=".length);
	const store = path.join(process.env.HOME, ".gemini", name);
	const brain = path.join(store, "brain", conversationId, ".system_generated", "logs");
	mkdirSync(brain, { recursive: true });
	mkdirSync(path.join(store, "conversations"), { recursive: true });
	mkdirSync(path.join(store, "presence"), { recursive: true });
	writeFileSync(path.join(brain, "transcript_full.jsonl"), `${prompt}\n`);
	writeFileSync(path.join(store, "conversations", `${conversationId}.db`), prompt);
	writeFileSync(path.join(store, "presence", `${conversationId}.lock`), "");
}

async function review() {
	// Bounded, so that a test that fails before it opens the gate leaves no fake behind.
	const giveUp = Date.now() + 30_000;
	while (process.env.FAKE_AGY_GATE && !existsSync(process.env.FAKE_AGY_GATE) && Date.now() < giveUp) await new Promise((resolve) => setTimeout(resolve, 20));
	await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_AGY_DELAY ?? 0)));
	const usage = (input, cacheRead) => ({ input, output: 5, cacheRead });
	const save = { action: "create", name: "fake-skill", description: "Use when testing the fake", body: "1. Do it." };
	process.stdout.write("WARN: not an event\n");
	if (mode === "failed") {
		emit(agyStream.init({}, conversationId), agyStream.result(JSON.parse(process.env.FAKE_AGY_RESULT ?? '{"status":"ERROR"}'), conversationId));
		process.exit(3);
	}
	const outcome = mode === "refused" ? {} : { output: 'Created skill "fake-skill" at ~/.gemini/config/skills/fake-skill/SKILL.md.' };
	emit(
		agyStream.init({}, conversationId),
		agyStream.step(0, "DONE", "user_input", {}, conversationId),
		agyStream.reply(1, { ...usage(2000, 500), output: 50 }),
		(process.env.FAKE_AGY_EAGER ? agyStream.eagerSkill : agyStream.skill)(2, save, outcome),
		agyStream.reply(4, usage(2100, 2000)),
		agyStream.result(mode === "refused" ? { denied_actions: Array.from({ length: Number(process.env.FAKE_AGY_DENIED ?? 1) }, () => ({ action: "mcp", display_name: "McpTool" })) } : {}, conversationId),
	);
}

// A review waiting for the model: its init is printed, which is what the tests wait for.
function hang() {
	emit(agyStream.init({}, conversationId));
	record({ ready: true });
	idle();
}

// Starts a child that ignores SIGTERM, as an MCP server might, and prints the init once it does: a signal sent
// before then would find the child with its default handling and end it. The tests wait for the record.
async function startChild() {
	const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
	await new Promise((resolve) => child.stdout.once("data", resolve));
	child.stdout.destroy();
	emit(agyStream.init({}, conversationId));
	record({ ready: true, grandchild: child.pid });
}

function stubborn() {
	process.on("SIGTERM", () => {});
	startChild();
	setTimeout(() => process.exit(0), 8000);
}

function polite() {
	process.on("SIGTERM", () => {
		emit(agyStream.result({ status: "ERROR", error: "interrupted" }, conversationId));
		process.exit(1);
	});
	startChild();
	idle();
}

function rogue() {
	if (process.env.FAKE_AGY_IGNORE_SIGTERM) process.on("SIGTERM", () => record({ terminated: true }));
	emit(agyStream.init({}, conversationId), agyStream.call(1, "run_command", { CommandLine: "cat ~/.aws/credentials" })[0]);
	setTimeout(() => {
		writeFileSync(process.env.FAKE_AGY_MARKER, "the review carried on");
		process.exit(0);
	}, 8000);
}

// agy running the review under its default agent, as it might if it did not find the plugin's: nothing limits that run, so it must not be waited for.
function stranger() {
	emit(agyStream.init({ agent: "default" }, conversationId));
	setTimeout(() => {
		writeFileSync(process.env.FAKE_AGY_MARKER, "the review carried on");
		process.exit(0);
	}, 8000);
}

function crash() {
	process.stdout.write(`${JSON.stringify(agyStream.init({}, conversationId))}\n`, () => process.kill(process.pid, "SIGKILL"));
}
