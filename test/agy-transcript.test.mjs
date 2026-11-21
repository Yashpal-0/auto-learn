import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { EXCERPT_LIMITS, renderTurn, scanTurn } from "../scripts/lib/agy-transcript.mjs";
import { MAX_LINE_BYTES } from "../scripts/lib/jsonl.mjs";
import { agy, agyTurn, tempDir, toJsonl } from "./helpers.mjs";

/** A conversation agy 1.5.14 wrote for three shell commands, as it is. */
const REAL = new URL("./fixtures/agy-transcript.jsonl", import.meta.url).pathname;

async function transcript(t, records, tail = "") {
	const file = path.join(await tempDir(t), "transcript_full.jsonl");
	await fs.writeFile(file, toJsonl(records) + tail);
	return file;
}

const sizeOf = async (file) => (await fs.stat(file)).size;
/** Where record `index` starts in the file that holds `records`. */
const offsetOf = (records, index) => Buffer.byteLength(toJsonl(records.slice(0, index)));

test("scanTurn reads a transcript agy wrote: the turn starts at its prompt and made three tool calls", async () => {
	assert.deepEqual(await scanTurn(REAL), { offset: 0, promptId: "0", toolCalls: 3, end: await sizeOf(REAL) });
});

test("scanTurn takes the last turn, counts only its tool calls, and says where it starts", async (t) => {
	const records = [...agyTurn(0, 2, "First task"), ...agyTurn(10, 6, "Second task")];
	const file = await transcript(t, records);
	assert.deepEqual(await scanTurn(file), { offset: offsetOf(records, 6), promptId: "10", toolCalls: 6, end: await sizeOf(file) });
});

test("scanTurn and renderTurn count offsets in bytes: after multibyte text, the turn starts at its prompt", async (t) => {
	const first = agyTurn(0, 2, "Déployer la base 日本語 🚀");
	first[2] = agy.result(2, "Résultat: 成功 ✓");
	const records = [...first, ...agyTurn(10, 2, "Second task")];
	const file = await transcript(t, records);
	const turn = await scanTurn(file);
	assert.equal(turn.offset, offsetOf(records, first.length));
	assert.match(await renderTurn(file, turn.offset, turn.end), /^\[user\]\nSecond task\n/);
});

test("scanTurn gives the true offset of the turn after a line too long to read", async (t) => {
	const file = await transcript(t, agyTurn(0, 1, "First task"));
	// agy may keep a whole tool output in one line; readLines leaves a line over its limit out.
	const handle = await fs.open(file, "a");
	try {
		await handle.write(`{"step_index":5,"source":"MODEL","type":"GENERIC","status":"DONE","content":"`);
		await handle.write(Buffer.alloc(MAX_LINE_BYTES, "x"));
		await handle.write(`"}\n`);
	} finally {
		await handle.close();
	}
	const secondTurnStart = await sizeOf(file);
	await fs.appendFile(file, toJsonl(agyTurn(10, 2, "Second task")));
	const turn = await scanTurn(file);
	assert.deepEqual([turn.offset, turn.promptId, turn.toolCalls], [secondTurnStart, "10", 2]);
});

test("scanTurn counts each call of a model step that makes several, and none for a step that makes none", async (t) => {
	const records = [
		agy.prompt(0, "Do it"),
		agy.reply(1, { thinking: "plan", calls: [agy.call("view_file"), agy.call("view_file"), agy.call("run_command")] }),
		agy.result(2, "a"),
		agy.result(3, "b"),
		agy.result(4, "c"),
		agy.reply(5, { content: "Done." }),
	];
	assert.equal((await scanTurn(await transcript(t, records))).toolCalls, 3);
});

test("scanTurn gives the same turn from the offset saved at the last stop as from the start", async (t) => {
	const records = [...agyTurn(0, 2, "First task"), ...agyTurn(10, 6, "Second task")];
	const file = await transcript(t, records);
	const whole = await scanTurn(file);
	assert.deepEqual(await scanTurn(file, offsetOf(records, 0)), whole);
	assert.deepEqual(await scanTurn(file, whole.offset), whole);
});

test("scanTurn reads the whole file again when the saved offset no longer leads to a prompt, as after the file was rewritten", async (t) => {
	const records = [...agyTurn(0, 2, "First task"), ...agyTurn(10, 6, "Second task")];
	const file = await transcript(t, records);
	const whole = await scanTurn(file);
	const stale = [
		(await sizeOf(file)) + 500, // beyond the end of a file that shrank
		offsetOf(records, 3) + 7, // in the middle of a record
		offsetOf(records, 8), // after the last prompt, inside its turn
		await sizeOf(file), // exactly at the end
	];
	for (const offset of stale) assert.deepEqual(await scanTurn(file, offset), whole, String(offset));
});

test("scanTurn leaves a line that is still being written for the next stop", async (t) => {
	const records = agyTurn(0, 5);
	const partial = JSON.stringify(agy.reply(99, { calls: [agy.call("run_command")] }));
	const file = await transcript(t, records, partial.slice(0, 40));
	const turn = await scanTurn(file);
	assert.equal(turn.toolCalls, 5);
	assert.equal(turn.end, offsetOf(records, records.length));
});

test("only a prompt a person typed starts a turn", async (t) => {
	const records = [
		...agyTurn(0, 2),
		{ ...agy.prompt(10, "Injected by the system"), source: "SYSTEM" },
		agy.system(11, "Reminder: work efficiently."),
		agy.reply(12, { calls: [agy.call("run_command")] }),
	];
	assert.deepEqual(await scanTurn(await transcript(t, records)), { offset: 0, promptId: "0", toolCalls: 3, end: offsetOf(records, records.length) });
});

test("scanTurn finds no turn in an empty file, or one without a prompt", async (t) => {
	assert.equal(await scanTurn(await transcript(t, [])), undefined);
	assert.equal(await scanTurn(await transcript(t, [agy.reply(1, { calls: [agy.call("run_command")] }), "not json"])), undefined);
});

test("renderTurn writes a turn as text: the request without agy's metadata, the calls with their arguments, the results and the reply", async (t) => {
	const records = agyTurn(0, 1, "Fix the build");
	const file = await transcript(t, records);
	assert.equal(
		await renderTurn(file, 0, await sizeOf(file)),
		[
			"[user]\nFix the build",
			'[tool call] run_command\n{"CommandLine":"step 1"}',
			"[tool result]\nCommand exited with code 0.\n\nCommand output:\nok 1",
			"[assistant]\nDone: the database is ready.",
		].join("\n\n"),
	);
});

test("renderTurn renders a real agy turn without the reasoning, the settings notice or the system reminders", async () => {
	const text = await renderTurn(REAL, 0, await sizeOf(REAL));
	assert.match(text, /^\[user\]\nRun these three shell commands/);
	assert.match(text, /\[tool call\] run_command\n\{"CommandLine":"echo one","WaitMsBeforeAsync":5000,"toolSummary":"Echo one"\}/);
	assert.match(text, /\[tool result\]\n[^[]*Command output:\none/);
	assert.match(text, /\[assistant\]\ndone$/);
	assert.doesNotMatch(text, /ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|Reminder: work efficiently/);
});

test("renderTurn leaves out reasoning, shows a failed step's error, and reads only the records that start in the range", async (t) => {
	const records = [
		agy.prompt(0, "Earlier turn"),
		agy.prompt(1, "Run it"),
		agy.reply(2, { thinking: "SECRET PLAN", calls: [agy.call("run_command", { CommandLine: "false" })] }),
		agy.result(3, "", { status: "ERROR", error: "permission denied" }),
		agy.system(4, "Reminder"),
		agy.reply(5, { content: "It failed." }),
	];
	const file = await transcript(t, records);
	const text = await renderTurn(file, offsetOf(records, 1), await sizeOf(file));
	assert.doesNotMatch(text, /Earlier turn|SECRET PLAN|Reminder/);
	assert.match(text, /\[tool error\]\npermission denied/);
	assert.match(text, /^\[user\]\nRun it/);
});

test("renderTurn cuts each kind of text to its limit", async (t) => {
	const limits = { user: 20, reply: 30, args: 25, result: 40, total: 100_000 };
	const long = (label) => label.repeat(500);
	const records = [
		agy.prompt(0, long("u")),
		agy.reply(1, { content: long("r"), calls: [agy.call("run_command", { CommandLine: long("a") })] }),
		agy.result(2, long("o")),
	];
	const file = await transcript(t, records);
	const text = await renderTurn(file, 0, await sizeOf(file), limits);
	assert.match(text, /\[user\]\nu{20}… \[\d+ more characters\]/);
	assert.match(text, /\[assistant\]\nr{30}… \[\d+ more characters\]/);
	// {"CommandLine":" takes 16 of the 25 characters.
	assert.match(text, /\[tool call\] run_command\n\{"CommandLine":"a{9}… \[\d+ more characters\]/);
	assert.match(text, /\[tool result\]\no{40}… \[\d+ more characters\]/);
});

test("renderTurn drops the oldest middle steps of a turn over its total, and says how many", async (t) => {
	const records = agyTurn(0, 40, "Long job");
	const file = await transcript(t, records);
	const text = await renderTurn(file, 0, await sizeOf(file), { ...EXCERPT_LIMITS, total: 1500 });
	assert.ok(text.length <= 1500 + 100, String(text.length));
	assert.match(text, /^\[user\]\nLong job\n\n\[… \d+ earlier steps left out …\]\n\n/);
	const omitted = Number(/\[… (\d+) earlier steps left out …\]/.exec(text)[1]);
	assert.ok(omitted > 0 && omitted < 80, String(omitted));
	// The end of the turn stays.
	assert.match(text, /\[assistant\]\nDone: the database is ready\.$/);
	assert.match(text, /step 40/);
	assert.doesNotMatch(text, /step 1\b/);
});

test("renderTurn leaves a turn that fits whole", async (t) => {
	const records = agyTurn(0, 40, "Long job");
	const file = await transcript(t, records);
	const text = await renderTurn(file, 0, await sizeOf(file));
	assert.doesNotMatch(text, /left out/);
	assert.match(text, /step 1\b/);
	assert.match(text, /step 40/);
});
