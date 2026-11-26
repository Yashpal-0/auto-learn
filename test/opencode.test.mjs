import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import plugin, { setupOpenCode } from "../opencode/index.mjs";
import { MARKER_FILE } from "../scripts/lib/skills.mjs";
import { completedTurn, deferred, nativeHost, proposal, successEvent } from "./opencode-helpers.mjs";

const call = { sessionID: "ses_native", agent: "build", messageID: "msg_tool", id: "call_save" };

async function setup(t, options = {}) {
	const host = await nativeHost(t);
	host.ctx.options = options;
	const cleanup = await setupOpenCode(host.ctx, { env: host.env });
	t.after(cleanup);
	return host;
}

test("the native plugin registers a skill tool that saves through the managed store and refreshes OpenCode", async (t) => {
	const host = await setup(t, { autoCapture: false });
	assert.equal(plugin.id, "auto-learn");
	const tool = host.tools.get("manage_skill");
	assert.equal(tool.options.namespace, "auto_learn");
	assert.deepEqual(tool.input.required, ["action", "name"]);
	const result = await tool.execute(proposal, call);
	assert.deepEqual(host.lastPermissionAssert.resources, ["native-build"]);
	assert.deepEqual(host.lastPermissionAssert.save, ["*"]);
	assert.match(result.content, /Created skill "native-build"/);
	assert.match(await fs.readFile(path.join(host.library, "native-build", "SKILL.md"), "utf8"), /Run the verified build command/);
	await fs.access(path.join(host.library, "native-build", MARKER_FILE));
	await host.saved.promise;
	assert.ok((await host.ctx.skill.list()).data.some((skill) => skill.id === "native-build"));
});

test("native saves respect permissions and refuse collisions anywhere in OpenCode's catalog", async (t) => {
	const host = await setup(t, { autoCapture: false });
	const tool = host.tools.get("manage_skill");
	host.catalog.push({ id: "native-build", name: "Existing", path: "/ancestor/.agents/skills/native-build.md", content: "Keep it" });
	await assert.rejects(tool.execute({ ...proposal, name: " Native-Build " }, call), /already exists/);
	await assert.rejects(fs.access(host.library));
	host.catalog = [];
	host.permission = "ask";
	await assert.rejects(tool.execute({ ...proposal, name: "bad name!" }, call), /valid skill name/);
	await assert.rejects(tool.execute(undefined, call), /action must be/);
	assert.equal(host.prompts, 0);
	host.permission = "deny";
	await assert.rejects(tool.execute(proposal, call), /Permission denied/);
	await assert.rejects(fs.access(host.library));
});

test("native saves refuse sessions that moved to another directory or workspace", async (t) => {
	for (const kind of ["directory", "workspace"]) {
		const host = await setup(t, { autoCapture: false });
		host.session.location = kind === "directory" ? { directory: path.join(host.project, "other") } : { directory: host.project, workspaceID: "wrk_other" };
		await assert.rejects(host.tools.get("manage_skill").execute(proposal, call), /session moved/i);
		await assert.rejects(fs.access(host.library));
	}
});

test("native session guidance runs on context, compaction and generate, handles symlinks, and survives catalog errors", async (t) => {
	const host = await nativeHost(t);
	const realLibrary = path.join(host.root, "real-skills");
	await fs.mkdir(realLibrary, { recursive: true });
	await fs.symlink(realLibrary, host.library);
	host.ctx.options = { autoCapture: false };
	const cleanup = await setupOpenCode(host.ctx, { env: host.env });
	t.after(cleanup);
	await host.tools.get("manage_skill").execute(proposal, call);
	// Simulate OpenCode reporting realpath while AUTO_LEARN_SKILLS_DIR is a symlink
	host.ctx.skill.list = async () => ({ location: { directory: host.project }, data: [{ id: "native-build", path: path.join(realLibrary, "native-build", "SKILL.md") }] });
	for (const hook of ["context", "compaction", "generate"]) {
		const request = { sessionID: "ses_native", agent: "build", system: [] };
		await host.hooks.session.get(hook)(request);
		assert.match(request.system.at(-1).text, /auto_learn/, hook);
		assert.match(request.system.at(-1).text, /native-build: Use when building this project/, hook);
	}
	host.ctx.skill.list = async () => ({ location: { directory: host.project }, data: [{ id: "native-build", path: path.join(realLibrary, "native-build", "SKILL.md"), autoinvoke: false }] });
	const hidden = { sessionID: "ses_native", agent: "build", system: [] };
	await host.hooks.session.get("context")(hidden);
	assert.doesNotMatch(hidden.system.at(-1).text, /native-build:/);
	host.ctx.skill.list = async () => { throw new Error("transient catalog failure"); };
	const resilient = { sessionID: "ses_native", agent: "build", system: [] };
	await host.hooks.session.get("context")(resilient);
	assert.match(resilient.system.at(-1).text, /auto_learn/);
});

test("native plugin options reject unsafe thresholds instead of disabling reviews accidentally", async (t) => {
	for (const options of [{ minToolCalls: -1 }, { minToolCalls: 1.5 }, { minToolCalls: "5" }, { autoCapture: "false" }]) {
		const host = await nativeHost(t);
		host.ctx.options = options;
		await assert.rejects(setupOpenCode(host.ctx, { env: host.env }), /autoCapture|minToolCalls/);
	}
});

const logFile = (host) => path.join(host.env.XDG_DATA_HOME, "opencode", "auto-learn", "auto-learn.log");

test("successful native turns trigger a tool-free review once and refresh the saved skill", { timeout: 1000 }, async (t) => {
	const host = await setup(t);
	assert.ok(host.hooks.session.has("generate"), "background reviews must register a generation hook");
	host.messages = completedTurn();
	host.response = { text: JSON.stringify(proposal), cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 30, write: 0 } } };
	await host.send(successEvent(host.project));
	await host.finished.promise;
	const generated = await host.generated.promise;
	assert.deepEqual(generated.tools, {});
	assert.equal(generated.options.maxTokens, undefined);
	assert.match(generated.system.at(-1)?.text ?? "", /auto_learn/);
	assert.match(await fs.readFile(path.join(host.library, "native-build", "SKILL.md"), "utf8"), /verified build command/);
	const log = (await fs.readFile(logFile(host), "utf8")).trim().split("\n").map(JSON.parse);
	assert.equal(log[0].event, "queued");
	assert.equal(log[1].outcome, "ok");
	assert.deepEqual(log[1].created, ["native-build"]);
	assert.doesNotMatch(JSON.stringify(log), /verified build command/);
	await host.send(successEvent(host.project));
	assert.equal(host.generations, 1);
});

test("native reviews skip short, plan, child and other-location sessions", { timeout: 1000 }, async (t) => {
	for (const kind of ["short", "plan", "child", "location"]) {
		const host = await setup(t);
		assert.ok(host.hooks.session.has("generate"));
		host.messages = completedTurn(kind === "short" ? 4 : 5, kind === "plan" ? "plan" : "build");
		if (kind === "child") host.session.parentID = "ses_parent";
		await host.send(successEvent(kind === "location" ? path.join(host.project, "other") : host.project));
		assert.equal(host.generations, 0, kind);
		await assert.rejects(fs.access(host.library));
	}
});

test("a new native prompt discards a late review result", { timeout: 1000 }, async (t) => {
	const host = await setup(t);
	assert.ok(host.hooks.session.has("generate"));
	host.messages = completedTurn();
	const response = deferred();
	host.response = response.promise;
	await host.send(successEvent(host.project));
	await host.generated.promise;
	await host.hooks.session.get("prompt")({ sessionID: "ses_native", messageID: "msg_next", prompt: { text: "Next task" }, delivery: "steer" });
	await host.finished.promise;
	response.resolve({ text: JSON.stringify(proposal) });
	await response.promise;
	await assert.rejects(fs.access(host.library));
	assert.match(await fs.readFile(logFile(host), "utf8"), /"outcome":"aborted"/);
});

test("moving a native session cancels its review even when the event names the destination", { timeout: 1000 }, async (t) => {
	const host = await setup(t);
	host.messages = completedTurn();
	const response = deferred();
	host.response = response.promise;
	await host.send(successEvent(host.project));
	await host.generated.promise;
	const destination = { directory: path.join(host.project, "other") };
	host.session.location = destination;
	await host.send({ ...successEvent(host.project), type: "session.moved", location: destination, data: { sessionID: "ses_native", location: destination } });
	response.resolve({ text: JSON.stringify(proposal) });
	await host.finished.promise;
	assert.match(await fs.readFile(logFile(host), "utf8"), /"outcome":"aborted"/);
	await assert.rejects(fs.access(host.library));
});

test("a native review rerouted to a location without its job is refused", { timeout: 1000 }, async (t) => {
	const source = await setup(t);
	const destination = await setup(t);
	source.messages = completedTurn();
	source.ctx.session.generate = destination.ctx.session.generate;
	await source.send(successEvent(source.project));
	await source.finished.promise;
	assert.match(await fs.readFile(logFile(source), "utf8"), /"outcome":"error"/);
	await assert.rejects(fs.access(source.library));
	await assert.rejects(fs.access(destination.library));
});

test("automatic native saves honor ask and deny rules without opening permission prompts", { timeout: 1000 }, async (t) => {
	for (const permission of ["ask", "deny"]) {
		const host = await setup(t);
		assert.ok(host.hooks.session.has("generate"));
		host.permission = permission;
		host.messages = completedTurn();
		host.response = { text: JSON.stringify(proposal) };
		await host.send(successEvent(host.project));
		await host.finished.promise;
		assert.equal(host.prompts, 0);
		await assert.rejects(fs.access(host.library));
		assert.match(await fs.readFile(logFile(host), "utf8"), /skill proposal refused/);
	}
});

test("unloading the native plugin discards outstanding proposals", { timeout: 1000 }, async (t) => {
	const host = await nativeHost(t);
	const cleanup = await setupOpenCode(host.ctx, { env: host.env });
	assert.ok(host.hooks.session.has("generate"));
	host.messages = completedTurn();
	const response = deferred();
	host.response = response.promise;
	await host.send(successEvent(host.project));
	await host.generated.promise;
	await cleanup();
	response.resolve({ text: JSON.stringify(proposal) });
	await response.promise;
	await assert.rejects(fs.access(host.library));
});

test("another plugin's transient generation is left unchanged during a review", { timeout: 1000 }, async (t) => {
	const host = await setup(t);
	host.messages = completedTurn();
	const response = deferred();
	host.response = response.promise;
	await host.send(successEvent(host.project));
	await host.generated.promise;
	const other = { sessionID: "ses_native", messages: [{ role: "user", content: [{ type: "text", text: "Unrelated transient request" }] }], tools: { read: {} }, options: {} };
	await host.hooks.session.get("generate")(other);
	assert.deepEqual(other.tools, { read: {} });
	assert.deepEqual(other.options, {});
	response.resolve({ text: "null" });
	await host.finished.promise;
});

test("deleting a native session cancels its review and removes its bookkeeping", { timeout: 1000 }, async (t) => {
	const host = await setup(t);
	host.messages = completedTurn();
	const response = deferred();
	host.response = response.promise;
	await host.send(successEvent(host.project));
	await host.generated.promise;
	await host.send({ ...successEvent(host.project), type: "session.deleted" });
	response.resolve({ text: JSON.stringify(proposal) });
	await response.promise;
	assert.equal(host.storage.size, 0);
	await assert.rejects(fs.access(host.library));
});

test("a zero native tool threshold reviews a successful user turn without tool calls", { timeout: 1000 }, async (t) => {
	const host = await setup(t, { minToolCalls: 0 });
	host.messages = completedTurn(0);
	await host.send(successEvent(host.project));
	await host.finished.promise;
	assert.equal(host.generations, 1);
});

test("cancelled native requests still count toward the provider concurrency limit until they settle", { timeout: 1000 }, async (t) => {
	const host = await setup(t);
	const response = deferred();
	host.response = response.promise;
	for (let index = 0; index < 4; index++) {
		const started = deferred();
		host.onGenerate = started.resolve;
		host.messages = completedTurn(5, "build", `turn${index}`);
		const event = successEvent(host.project, `turn${index}`);
		event.data.sessionID = `ses_${index}`;
		await host.send(event);
		await started.promise;
		await host.send({ ...event, type: "session.deleted" });
	}
	host.messages = completedTurn(5, "build", "next");
	await host.send(successEvent(host.project, "next"));
	assert.match(await fs.readFile(logFile(host), "utf8"), /review concurrency limit reached/);
	assert.equal(host.generations, 4);
	response.resolve({ text: "null" });
});

test("an unanswered approval prompt does not hold up other saves or the plugin's unload", { timeout: 1000 }, async (t) => {
	const host = await nativeHost(t);
	host.ctx.options = { autoCapture: false };
	const cleanup = await setupOpenCode(host.ctx, { env: host.env });
	const tool = host.tools.get("manage_skill");
	const approval = deferred();
	const assertPermission = host.ctx.permission.assert;
	host.ctx.permission.assert = (input) => input.resources[0] === "left-waiting" ? approval.promise : assertPermission(input);
	const waiting = tool.execute({ ...proposal, name: "left-waiting" }, call);
	waiting.catch(() => {});
	assert.match((await tool.execute({ ...proposal, name: "other-skill" }, call)).content, /Created skill "other-skill"/);
	await cleanup();
	approval.resolve();
	await assert.rejects(waiting, /unloaded/);
	await assert.rejects(fs.access(path.join(host.library, "left-waiting")));
});

test("native reviews add the tool results seen before an auto-compaction to the ones the session context still shows", { timeout: 1000 }, async (t) => {
	for (const results of [4, 5]) {
		const host = await setup(t);
		host.messages = completedTurn(2, "build", "late");
		host.messages[0] = { id: "msg_compact_0", type: "compaction", status: "completed", reason: "auto", summary: "Earlier steps", time: { created: 1 } };
		const event = (type, sessionID = "ses_native") => ({ ...successEvent(host.project), type, data: { sessionID } });
		await host.send(event("session.execution.started"));
		for (let n = 0; n < results; n++) await host.send(event(n % 2 ? "session.tool.failed" : "session.tool.success"));
		await host.send(event("session.tool.success", "ses_other"));
		await host.send(successEvent(host.project, "late"));
		await host.finished.promise;
		assert.equal(host.generations, results === 5 ? 1 : 0, `${results} results`);
		if (results === 4) assert.match(await fs.readFile(logFile(host), "utf8"), /fewer than 5 tool calls.*"toolCalls":4/);
	}
});

test("a Code Mode call from before an auto-compaction counts the calls its script made, as the session context would", { timeout: 1000 }, async (t) => {
	const host = await setup(t);
	host.messages = completedTurn(2, "build", "late");
	host.messages[0] = { id: "msg_compact_0", type: "compaction", status: "completed", reason: "auto", summary: "Earlier steps", time: { created: 1 } };
	const event = (type, metadata) => ({ ...successEvent(host.project), type, data: { sessionID: "ses_native", ...(metadata ? { metadata } : {}) } });
	await host.send(event("session.execution.started"));
	// Four inner calls, then one that lists none, so it counts once: five calls from two events.
	await host.send(event("session.tool.success", { toolCalls: [{ tool: "read" }, { tool: "read" }, { tool: "read" }, { tool: "read" }] }));
	await host.send(event("session.tool.failed", { toolCalls: [] }));
	await host.send(successEvent(host.project, "late"));
	await host.finished.promise;
	assert.equal(host.generations, 1);
});
