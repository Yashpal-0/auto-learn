import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createMcpServer } from "../scripts/lib/mcp.mjs";
import { tempDir } from "./helpers.mjs";

const SERVER_SCRIPT = new URL("../scripts/mcp-server.mjs", import.meta.url).pathname;

async function server(t) {
	const root = await tempDir(t);
	const context = { skillsDir: path.join(root, "skills"), projectDir: path.join(root, "project") };
	return { ...context, handle: createMcpServer(context) };
}

const call = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "manage_skill", arguments: args } });
const createArgs = { action: "create", name: "deploy-docs", description: "Use when shipping docs", body: "1. Build.\n2. Upload." };

test("initialize agrees on a protocol version and announces the tool capability", async (t) => {
	const { handle } = await server(t);
	const reply = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
	assert.equal(reply.id, 1);
	assert.equal(reply.result.protocolVersion, "2025-06-18");
	assert.deepEqual(reply.result.capabilities, { tools: {} });
	assert.equal(reply.result.serverInfo.name, "auto-learn");
	const newer = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
	assert.equal(newer.result.protocolVersion, "2025-11-25");
});

test("notifications and responses get no reply, ping gets an empty result", async (t) => {
	const { handle } = await server(t);
	assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
	assert.equal(await handle({ jsonrpc: "2.0", id: 9, result: {} }), undefined);
	assert.deepEqual(await handle({ jsonrpc: "2.0", id: 3, method: "ping" }), { jsonrpc: "2.0", id: 3, result: {} });
});

test("tools/list offers manage_skill with a strict schema", async (t) => {
	const { handle } = await server(t);
	const { result } = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	assert.equal(result.tools.length, 1);
	const [tool] = result.tools;
	assert.equal(tool.name, "manage_skill");
	assert.match(tool.description, /never changes a skill it did not create/);
	assert.deepEqual(tool.inputSchema.required, ["action", "name"]);
	assert.deepEqual(tool.inputSchema.properties.action.enum, ["read", "create", "update", "delete"]);
	assert.equal(tool.inputSchema.properties.revision.type, "string");
	assert.equal(tool.inputSchema.additionalProperties, false);
});

test("tools/call runs manage_skill and reports refusals as tool errors", async (t) => {
	const { handle, skillsDir } = await server(t);
	const created = await handle(call(1, createArgs));
	assert.equal(created.result.isError, undefined);
	assert.match(created.result.content[0].text, /^Created skill "deploy-docs"/);
	await fs.access(path.join(skillsDir, "deploy-docs", "SKILL.md"));

	const again = await handle(call(2, createArgs));
	assert.equal(again.result.isError, true);
	assert.match(again.result.content[0].text, /already exists/);
});

test("Claude MCP clients read revisions and refuse stale mutations from another client", async (t) => {
	const { handle, skillsDir, projectDir } = await server(t);
	const other = createMcpServer({ skillsDir, projectDir });
	await handle(call(1, createArgs));
	const read = await handle(call(2, { action: "read", name: createArgs.name }));
	assert.equal(read.result.isError, undefined);
	const snapshot = JSON.parse(read.result.content[0].text);
	const updated = await other(call(3, { ...createArgs, action: "update", body: "New verified steps.", revision: snapshot.revision }));
	assert.equal(updated.result.isError, undefined);
	for (const action of ["update", "delete"]) {
		const refused = await handle(call(4, { ...createArgs, action, revision: snapshot.revision }));
		assert.equal(refused.result.isError, true);
		assert.match(refused.result.content[0].text, /changed.*read/i);
	}
	assert.match(await fs.readFile(path.join(skillsDir, createArgs.name, "SKILL.md"), "utf8"), /New verified steps/);
});

test("separate Claude MCP processes cannot save competing copies of one revision", async (t) => {
	const root = await tempDir(t);
	const client = () => {
		const child = spawn(process.execPath, [SERVER_SCRIPT], {
			env: { ...process.env, AUTO_LEARN_SKILLS_DIR: path.join(root, "skills"), CLAUDE_PROJECT_DIR: root },
			stdio: ["pipe", "pipe", "inherit"],
		});
		t.after(() => child.kill());
		const replies = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
		let id = 0;
		return async (args) => {
			child.stdin.write(`${JSON.stringify(call(++id, args))}\n`);
			return JSON.parse((await replies.next()).value).result;
		};
	};
	const first = client();
	const second = client();
	assert.equal((await first(createArgs)).isError, undefined);
	const snapshot = JSON.parse((await first({ action: "read", name: createArgs.name })).content[0].text);
	const saved = await Promise.all([first, second].map((request, i) => request({ ...createArgs, action: "update", body: `Writer ${i}.`, revision: snapshot.revision })));
	assert.equal(saved.filter(({ isError }) => isError !== true).length, 1);
	assert.match(saved.find(({ isError }) => isError === true).content[0].text, /changed|changing/);
	assert.match(await fs.readFile(path.join(root, "skills", createArgs.name, "SKILL.md"), "utf8"), /Writer [01]\./);
});

test("unknown tools, unknown methods and malformed requests are JSON-RPC errors", async (t) => {
	const { handle } = await server(t);
	const unknownTool = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rm_rf" } });
	assert.equal(unknownTool.error.code, -32602);
	assert.equal((await handle({ jsonrpc: "2.0", id: 2, method: "resources/list" })).error.code, -32601);
	assert.equal((await handle({ id: 3, method: "ping" })).error.code, -32600);
	assert.equal((await handle([{ jsonrpc: "2.0", id: 4, method: "ping" }])).error.code, -32600);
});

/** A server for Codex, which names each call's project in the call's sandbox state. */
async function codexServer(t) {
	const root = await tempDir(t);
	const skillsDir = path.join(root, "skills");
	const projectDir = path.join(root, "project");
	return { root, skillsDir, projectDir, handle: createMcpServer({ skillsDir, host: "codex" }) };
}

const withSandbox = (message, sandboxCwd) => ({ ...message, params: { ...message.params, _meta: { "codex/sandbox-state": { sandboxCwd } } } });

test("the Codex server asks for each call's sandbox state and describes the tool for Codex", async (t) => {
	const { handle } = await codexServer(t);
	const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
	assert.deepEqual(init.result.capabilities, { tools: {}, experimental: { "codex/sandbox-state": {} } });
	const [tool] = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools;
	assert.match(tool.description, /Codex offers/);
	assert.match(tool.inputSchema.properties.description.description, /Codex matches tasks against it/);
	assert.deepEqual(tool.inputSchema.properties.action.enum, ["create", "update", "delete"]);
	assert.equal(tool.inputSchema.properties.revision, undefined);
	assert.doesNotMatch(JSON.stringify(tool), /Claude/);
});

test("the Codex server checks the project of the call's sandbox for a clashing skill", async (t) => {
	const { handle, skillsDir, projectDir } = await codexServer(t);
	const projectSkill = path.join(projectDir, ".agents", "skills", "deploy-docs");
	await fs.mkdir(projectSkill, { recursive: true });
	await fs.writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: deploy-docs\ndescription: Mine\n---\n\nHands off.\n");

	for (const sandboxCwd of [pathToFileURL(projectDir).href, projectDir]) {
		const refused = await handle(withSandbox(call(1, createArgs), sandboxCwd));
		assert.equal(refused.result.isError, true, sandboxCwd);
		assert.match(refused.result.content[0].text, /another name/);
	}
	// Without a usable sandbox directory there is no project to check.
	for (const sandboxCwd of ["relative/project", "file://remote-host/project", 7]) {
		await fs.rm(path.join(skillsDir, "deploy-docs"), { recursive: true, force: true });
		const created = await handle(withSandbox(call(2, createArgs), sandboxCwd));
		assert.equal(created.result.isError, undefined, String(sandboxCwd));
	}
});

test("the server script serves Codex with --host=codex and refuses other arguments", async (t) => {
	const root = await tempDir(t);
	const env = { ...process.env, AUTO_LEARN_SKILLS_DIR: path.join(root, "skills") };
	const child = spawn(process.execPath, [SERVER_SCRIPT, "--host=codex"], { env, stdio: ["pipe", "pipe", "inherit"] });
	// A failed assertion skips closing stdin, and the running server would keep the test from ending.
	t.after(() => child.kill());
	const replies = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
	const init = JSON.parse((await replies.next()).value);
	assert.deepEqual(init.result.capabilities.experimental, { "codex/sandbox-state": {} });
	child.stdin.end();

	const refused = spawn(process.execPath, [SERVER_SCRIPT, "--host=other"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	refused.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	assert.equal(await new Promise((resolve) => refused.once("close", resolve)), 1);
	assert.match(stderr, /^auto-learn: Unknown arguments \["--host=other"\]/);
});

test("the server script serves GitHub Copilot with --host=copilot: its skill library, and COPILOT_SESSION_CWD as the project", async (t) => {
	const root = await tempDir(t);
	const projectDir = path.join(root, "project");
	await fs.mkdir(path.join(projectDir, ".github", "skills", "deploy-docs"), { recursive: true });
	await fs.writeFile(path.join(projectDir, ".github", "skills", "deploy-docs", "SKILL.md"), "---\nname: deploy-docs\ndescription: The project's own\n---\n\nSteps.\n");
	// HOME holds ~/.agents/skills, the Codex library that Copilot reads too.
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, ".agents", "skills", "taken-by-codex"), { recursive: true });
	await fs.writeFile(path.join(home, ".agents", "skills", "taken-by-codex", "SKILL.md"), "---\nname: taken-by-codex\ndescription: Codex's own\n---\n\nSteps.\n");
	const env = { ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: path.join(root, "copilot"), COPILOT_SESSION_CWD: projectDir };
	delete env.AUTO_LEARN_SKILLS_DIR;
	const child = spawn(process.execPath, [SERVER_SCRIPT, "--host=copilot"], { cwd: root, env, stdio: ["pipe", "pipe", "inherit"] });
	// A failed assertion skips closing stdin, and the running server would keep the test from ending.
	t.after(() => child.kill());
	const replies = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const next = async () => JSON.parse((await replies.next()).value);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
	const [tool] = (await next()).result.tools;
	assert.match(tool.description, /GitHub Copilot offers/);
	assert.match(tool.inputSchema.properties.description.description, /GitHub Copilot/);
	child.stdin.write(`${JSON.stringify(call(2, createArgs))}\n`);
	assert.match((await next()).result.content[0].text, /another name/);
	child.stdin.write(`${JSON.stringify(call(3, { ...createArgs, name: "ship-docs" }))}\n`);
	assert.match((await next()).result.content[0].text, /^Created skill/);
	await fs.access(path.join(root, "copilot", "skills", "ship-docs", "SKILL.md"));
	child.stdin.write(`${JSON.stringify(call(4, { ...createArgs, name: "taken-by-codex" }))}\n`);
	assert.match((await next()).result.content[0].text, /another name/);
	child.stdin.end();
});

test("the server script speaks JSON-RPC over stdio and exits when stdin closes", async (t) => {
	const root = await tempDir(t);
	const child = spawn(process.execPath, [SERVER_SCRIPT], {
		env: { ...process.env, AUTO_LEARN_SKILLS_DIR: path.join(root, "skills"), CLAUDE_PROJECT_DIR: path.join(root, "project") },
		stdio: ["pipe", "pipe", "inherit"],
	});
	// A failed assertion skips closing stdin, and the running server would keep the test from ending.
	t.after(() => child.kill());
	const replies = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const next = async () => JSON.parse((await replies.next()).value);
	const exited = new Promise((resolve) => child.once("exit", resolve));

	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
	assert.equal((await next()).result.serverInfo.name, "auto-learn");
	child.stdin.write("{not json\n");
	assert.deepEqual(await next(), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
	child.stdin.write(`${JSON.stringify(call(2, createArgs))}\n`);
	assert.match((await next()).result.content[0].text, /^Created skill/);
	await fs.access(path.join(root, "skills", "deploy-docs", "SKILL.md"));

	child.stdin.end();
	assert.equal(await exited, 0);
});
