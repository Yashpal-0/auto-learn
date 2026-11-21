import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createStreamAnalyzer } from "../scripts/lib/agy-stream.mjs";
import { AGY_CONVERSATION, agyStream as stream } from "./helpers.mjs";

/** A run of agy 1.5.14, as it printed it. */
const recorded = (name) =>
	fs
		.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

/** Feeds the events in order and returns what the analyzer said to each one that made it say something, and its summary. */
function analyze(events) {
	const analyzer = createStreamAnalyzer();
	const said = [];
	for (const event of events) {
		const verdict = analyzer.accept(event);
		if (verdict !== undefined) said.push(verdict);
	}
	return { said, summary: analyzer.finish() };
}

const CREATE = { action: "create", name: "inotify-watch-limit", description: "Use when watchers run out.", body: "sudo sysctl fs.inotify.max_user_watches=524288" };
const SAVED = 'Created skill "inotify-watch-limit" at /home/me/.gemini/config/skills/inotify-watch-limit/SKILL.md.';

test("a recorded run that saved a skill reports the save, the tokens and how it ended, and nothing of the skill's text", () => {
	const { said, summary } = analyze(recorded("agy-review-stream.ndjson"));
	assert.deepEqual(said, []);
	assert.deepEqual(summary, {
		conversationId: AGY_CONVERSATION,
		status: "SUCCESS",
		deniedActions: 0,
		skillCalls: 1,
		saves: [{ action: "create", name: "inotify-watch-limit" }],
		otherToolCalls: 0,
		otherTools: [],
		inputTokens: 10616 + 6113,
		cacheReadTokens: 6113,
		outputTokens: 247,
	});
	assert.doesNotMatch(JSON.stringify(summary), /sysctl|file watchers/);
});

test("a recorded run whose permission was denied shows the denial and no save, though agy marked the call done", () => {
	const { said, summary } = analyze(recorded("agy-review-denied.ndjson"));
	assert.deepEqual(said, []);
	assert.equal(summary.status, "SUCCESS");
	assert.equal(summary.deniedActions, 1);
	assert.equal(summary.skillCalls, 1);
	assert.deepEqual(summary.saves, []);
});

test("a run agy could not start says why, clipped, and has no tokens", () => {
	const error = `failed to construct executor: ${"x".repeat(900)}`;
	const { summary } = analyze([stream.init(), stream.step(1, "DONE", "error_message"), stream.result({ status: "ERROR", error, finished_reason: "error" })]);
	assert.equal(summary.status, "ERROR");
	assert.equal(summary.finishedReason, "error");
	assert.match(summary.error, /^failed to construct executor: x+… \[\d+ more characters\]$/);
	assert.ok(summary.error.length < 560);
	assert.equal(summary.inputTokens + summary.outputTokens, 0);
});

test("a save counts once its call is done with output and no error, and not before", () => {
	const active = stream.skill(1, CREATE, { output: SAVED })[0];
	assert.deepEqual(analyze([active]).summary.saves, []);
	assert.deepEqual(analyze(stream.skill(1, CREATE, { output: SAVED })).summary.saves, [{ action: "create", name: "inotify-watch-limit" }]);
	const doneOnly = stream.skill(1, CREATE, { output: SAVED })[1];
	assert.deepEqual(analyze([doneOnly]).summary.saves, [{ action: "create", name: "inotify-watch-limit" }]);
	const twice = stream.skill(1, CREATE, { output: SAVED });
	assert.equal(analyze([...twice, twice[1]]).summary.saves.length, 1, "a repeated event is no second save");
	assert.equal(analyze(stream.skill(1, CREATE, { output: SAVED })).summary.skillCalls, 1, "its two events are one call");
});

test("a call that failed, was refused or changed nothing is no save", () => {
	const none = (events) => assert.deepEqual(analyze(events).summary.saves, []);
	none(stream.skill(1, CREATE, {}));
	none(stream.skill(1, CREATE, { output: "" }));
	none(stream.skill(1, CREATE, { output: "action must be create, update or delete.", error: "tool failed" }));
	none(stream.skill(1, { action: "bogus", name: "x" }, { output: "action must be create, update or delete." }));
	none(stream.skill(1, { action: "read", name: "x" }, { output: "text of the skill" }));
	none(stream.skill(1, { name: "x" }, { output: SAVED }));
	const done = stream.skill(1, CREATE, { output: SAVED })[1];
	done.step_update.tool_info.error = { type: "TOOL_ERROR", message: "late failure" };
	none([done]);
	const failed = stream.skill(1, CREATE, { output: SAVED })[1];
	failed.step_update.state = "ERROR";
	none([failed]);
	assert.equal(analyze(stream.skill(1, { action: "bogus", name: "x" }, { output: "no" })).summary.skillCalls, 1);
});

test("saves keep the order of the calls, so a create then an update reads in that order", () => {
	const events = [
		...stream.skill(1, CREATE, { output: SAVED }),
		...stream.skill(2, { action: "update", name: "inotify-watch-limit", body: "b", revision: "r" }, { output: "Updated skill." }),
		...stream.skill(3, { action: "delete", name: "old", revision: "r" }, { output: "Deleted skill." }),
	];
	assert.deepEqual(analyze(events).summary.saves, [
		{ action: "create", name: "inotify-watch-limit" },
		{ action: "update", name: "inotify-watch-limit" },
		{ action: "delete", name: "old" },
	]);
});

test("any tool but the plugin's manage_skill stops the review at the call, however harmless it looks", () => {
	const stops = {
		run_command: stream.call(1, "run_command", { CommandLine: "touch x" }),
		write_to_file: stream.call(1, "write_to_file", { TargetFile: "/x" }),
		view_file: stream.call(1, "view_file", { AbsolutePath: "/x" }),
		invoke_subagent: stream.call(1, "invoke_subagent", {}),
		browser_subagent: stream.call(1, "browser_subagent", {}),
		"call_mcp_tool:github/create_issue": stream.call(1, "call_mcp_tool", { ServerName: "github", ToolName: "create_issue", Arguments: {} }),
		"call_mcp_tool:auto-learn_auto-learn/other": stream.call(1, "call_mcp_tool", { ServerName: "auto-learn_auto-learn", ToolName: "other", Arguments: {} }),
		"call_mcp_tool:auto-learn-evil/manage_skill": stream.call(1, "call_mcp_tool", { ServerName: "auto-learn-evil", ToolName: "manage_skill", Arguments: CREATE }),
		"call_mcp_tool:auto-learn_other/manage_skill": stream.call(1, "call_mcp_tool", { ServerName: "auto-learn_other", ToolName: "manage_skill", Arguments: CREATE }),
		"call_mcp_tool:notauto-learn/manage_skill": stream.call(1, "call_mcp_tool", { ServerName: "notauto-learn", ToolName: "manage_skill", Arguments: CREATE }),
		"call_mcp_tool:?/?": stream.call(1, "call_mcp_tool", {}),
		"unknown tool": [stream.step(1, "ACTIVE", "tool", { tool_info: {} })],
	};
	for (const [name, events] of Object.entries(stops)) {
		const { said, summary } = analyze([stream.init(), ...events, ...stream.skill(2, CREATE, { output: SAVED }), stream.result()]);
		assert.deepEqual(said, [{ stop: name }], name);
		assert.equal(summary.stoppedTool, name);
		assert.deepEqual(summary.saves, [], `${name}: nothing counts after the stop`);
		assert.equal(summary.status, undefined, `${name}: the run ended there`);
	}
});

test("a manage_skill call of the plugin installed under another name is still the review's own", () => {
	for (const server of ["auto-learn_auto-learn", "auto-learn-2_auto-learn", "auto-learn"]) {
		const { said, summary } = analyze(stream.skill(1, CREATE, { output: SAVED }, server));
		assert.deepEqual(said, [], server);
		assert.equal(summary.saves.length, 1, server);
	}
});

test("the tools agy gives every agent are tolerated and counted by name", () => {
	const events = [
		...stream.call(1, "list_resources", {}, { output: "[]" }),
		...stream.call(2, "list_resources", {}, { output: "[]" }),
		...stream.call(3, "manage_task", { Action: "list" }, { output: "" }),
		...stream.call(4, "read_resource", { Uri: "x" }, { error: "not found" }),
	];
	const { said, summary } = analyze(events);
	assert.deepEqual(said, []);
	assert.equal(summary.otherToolCalls, 4);
	assert.equal(summary.skillCalls, 0);
	assert.deepEqual(summary.otherTools.sort(), ["list_resources", "manage_task", "read_resource"]);
	assert.equal(summary.stoppedTool, undefined);
});

test("tokens are those of the model requests so far, each reply counted once, and the result's own figures are not needed", () => {
	const reply = stream.reply(1, { input: 8161, output: 240 });
	const { summary } = analyze([stream.init(), reply, reply, stream.reply(3, { input: 2455, output: 7, thinking: 30, cacheRead: 6113 })]);
	assert.equal(summary.inputTokens, 8161 + 2455 + 6113);
	assert.equal(summary.cacheReadTokens, 6113);
	assert.equal(summary.outputTokens, 240 + 7 + 30);
	assert.equal(summary.status, undefined);
});

test("the conversation is the one the init event names, else the first one any event names", () => {
	assert.equal(analyze([stream.step(1, "DONE", "user_input", {}, "a"), stream.init({}, "b")]).summary.conversationId, "b");
	assert.equal(analyze([stream.step(1, "DONE", "user_input", {}, "a"), stream.step(2, "DONE", "user_input", {}, "c")]).summary.conversationId, "a");
	assert.equal(analyze([stream.step(1, "DONE", "user_input", {}, 7), { event: "init" }]).summary.conversationId, undefined);
});

test("what is not an event of the stream, or is malformed, changes nothing", () => {
	const junk = [null, 42, "text", [], {}, { event: "unknown" }, { event: "step_update" }, { event: "step_update", step_update: "x" }, { event: "result", result: "SUCCESS" }, { event: "result", result: null }];
	const { said, summary } = analyze(junk);
	assert.deepEqual(said, []);
	assert.deepEqual(summary, { deniedActions: 0, skillCalls: 0, saves: [], otherToolCalls: 0, otherTools: [], inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
});

test("fields of the wrong type are left out of the summary, and tokens that are no numbers count as none", () => {
	const reply = stream.step(1, "DONE", "agent_response", { usage: { input_tokens: "5", output_tokens: null, thinking_tokens: Number.NaN, cache_read_tokens: [3] } });
	const { summary } = analyze([reply, stream.result({ status: 5, finished_reason: {}, error: 7 })]);
	assert.deepEqual([summary.inputTokens, summary.cacheReadTokens, summary.outputTokens], [0, 0, 0]);
	for (const key of ["status", "finishedReason", "error"]) assert.equal(key in summary, false, key);
	const long = analyze([stream.result({ status: "x".repeat(500), finished_reason: "x".repeat(500) })]).summary;
	for (const key of ["status", "finishedReason"]) assert.ok(long[key].length < 200, `${key} is clipped`);
});

test("the model's own text, the user's prompt and system messages are no tool calls", () => {
	const { said, summary } = analyze([stream.step(1, "ACTIVE", "agent_response", { text_delta: "hi" }), stream.step(2, "DONE", "user_input"), stream.step(3, "DONE", "system_message"), stream.step(4, "DONE", "error_message")]);
	assert.deepEqual(said, []);
	assert.deepEqual([summary.skillCalls, summary.otherToolCalls, summary.saves], [0, 0, []]);
});

test("denied actions are counted from the result, and anything that is no list counts none", () => {
	assert.equal(analyze([stream.result({ denied_actions: [{ action: "mcp" }, { action: "run" }] })]).summary.deniedActions, 2);
	assert.equal(analyze([stream.result({ denied_actions: "mcp" })]).summary.deniedActions, 0);
	assert.equal(analyze([stream.result({ denied_actions: [] })]).summary.deniedActions, 0);
});

test("a tool that is not named stops the review, and its name is clipped", () => {
	const name = `run_${"x".repeat(400)}`;
	const { said } = analyze(stream.call(1, name, {}));
	assert.equal(said.length, 1);
	assert.match(said[0].stop, /^run_x+… \[\d+ more characters\]$/);
	assert.ok(said[0].stop.length < 300);
});
