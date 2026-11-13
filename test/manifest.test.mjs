import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const readJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
const EVENTS = { SessionStart: "session-start", Stop: "stop", SessionEnd: "session-end" };

/** Each hook's event and command, from a hooks file. */
const hookCommands = (file) =>
	Object.entries(readJson(file).hooks).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map((hook) => [event, hook.command])));

test("the Claude Code and Codex manifests name the same plugin at the same version", () => {
	const claude = readJson(".claude-plugin/plugin.json");
	const codex = readJson(".codex-plugin/plugin.json");
	assert.equal(codex.name, claude.name);
	assert.equal(codex.version, claude.version);
	assert.equal(readJson(".claude-plugin/marketplace.json").plugins[0].name, claude.name);
});

test("Codex runs the hooks and the MCP server from codex/, each with --host=codex", () => {
	const codex = readJson(".codex-plugin/plugin.json");
	assert.deepEqual([codex.hooks, codex.mcpServers], ["./codex/hooks.json", "./codex/mcp.json"]);
	assert.deepEqual(hookCommands(codex.hooks), Object.entries(EVENTS).map(([event, name]) => [event, `node "\${PLUGIN_ROOT}/scripts/hook.mjs" ${name} --host=codex`]));

	const server = readJson(codex.mcpServers).mcpServers["auto-learn"];
	assert.deepEqual(server.args, ["./scripts/mcp-server.mjs", "--host=codex"]);
	assert.ok(existsSync(path.join(ROOT, server.cwd, server.args[0])));
});

test("Claude Code runs the hooks and the MCP server without a host argument", () => {
	assert.deepEqual(hookCommands("hooks/hooks.json"), Object.entries(EVENTS).map(([event, name]) => [event, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" ${name}`]));
	assert.deepEqual(readJson(".mcp.json").mcpServers["auto-learn"].args, ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]);
});

test("every prompt has a Codex version", () => {
	assert.deepEqual(readdirSync(path.join(ROOT, "prompts", "codex")).sort(), readdirSync(path.join(ROOT, "prompts")).filter((name) => name.endsWith(".md")).sort());
});
