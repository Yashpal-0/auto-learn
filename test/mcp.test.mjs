import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
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
	assert.deepEqual(tool.inputSchema.properties.action.enum, ["create", "update", "delete"]);
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

test("unknown tools, unknown methods and malformed requests are JSON-RPC errors", async (t) => {
	const { handle } = await server(t);
	const unknownTool = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rm_rf" } });
	assert.equal(unknownTool.error.code, -32602);
	assert.equal((await handle({ jsonrpc: "2.0", id: 2, method: "resources/list" })).error.code, -32601);
	assert.equal((await handle({ id: 3, method: "ping" })).error.code, -32600);
	assert.equal((await handle([{ jsonrpc: "2.0", id: 4, method: "ping" }])).error.code, -32600);
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
