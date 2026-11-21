import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REVIEW_AGENT } from "../scripts/lib/agy.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const readJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
const EVENTS = { SessionStart: "session-start", Stop: "stop", SessionEnd: "session-end" };
/** The only fields agy keeps of a plugin manifest; it drops any other without a word. */
const AGY_MANIFEST_FIELDS = ["name", "description", "displayName", "version", "author", "homepage", "repository", "logo", "suggestedPrompts", "disabled"];

/** Each hook's event and command, from a hooks file. */
const hookCommands = (file) =>
	Object.entries(readJson(file).hooks).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map((hook) => [event, hook.command])));

test("the Claude Code, Codex, GitHub Copilot, Antigravity CLI and OpenCode manifests name the same plugin at the same version", () => {
	const claude = readJson(".claude-plugin/plugin.json");
	const codex = readJson(".codex-plugin/plugin.json");
	const copilot = readJson(".github/plugin/plugin.json");
	const agy = readJson(".antigravity-plugin/plugin.json");
	const opencode = readJson("package.json");
	assert.equal(agy.name, claude.name);
	assert.equal(agy.version, claude.version);
	assert.equal(codex.name, claude.name);
	assert.equal(codex.version, claude.version);
	assert.equal(copilot.name, claude.name);
	assert.equal(copilot.version, claude.version);
	assert.equal(opencode.name, claude.name);
	assert.equal(opencode.version, claude.version);
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
	assert.deepEqual(readJson(".claude-plugin/plugin.json").mcpServers["auto-learn"].args, ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]);
	// A root .mcp.json also loads as a project server in sessions opened in this repo, where ${CLAUDE_PLUGIN_ROOT} is unset.
	assert.equal(existsSync(path.join(ROOT, ".mcp.json")), false);
});

test("GitHub Copilot runs the hooks and the MCP server from copilot/, each with --host=copilot", () => {
	const copilot = readJson(".github/plugin/plugin.json");
	assert.deepEqual([copilot.hooks, copilot.mcpServers], ["./copilot/hooks.json", "./copilot/mcp.json"]);
	const hooks = readJson(copilot.hooks);
	assert.equal(hooks.version, 1);
	const names = { sessionStart: "session-start", agentStop: "stop", sessionEnd: "session-end" };
	assert.deepEqual(Object.keys(hooks.hooks), Object.keys(names));
	for (const [event, name] of Object.entries(names)) {
		const command = `node "\${PLUGIN_ROOT}/scripts/hook.mjs" ${name} --host=copilot`;
		assert.deepEqual(hooks.hooks[event].map(({ type, bash, powershell }) => [type, bash, powershell]), [["command", command, command]], event);
	}
	// The stop hook may wait 10 seconds for Copilot to write its own start to the events file.
	assert.ok(hooks.hooks.agentStop[0].timeoutSec > 10);
	for (const event of Object.keys(names)) assert.ok(hooks.hooks[event][0].timeoutSec > 0, event);
	const server = readJson(copilot.mcpServers).mcpServers["auto-learn"];
	assert.deepEqual([server.type, server.command, server.args], ["stdio", "node", ["${PLUGIN_ROOT}/scripts/mcp-server.mjs", "--host=copilot"]]);
	// Copilot loads a root .mcp.json or a .github/mcp.json in place of the manifest's mcpServers.
	assert.equal(existsSync(path.join(ROOT, ".github", "mcp.json")), false);
});

test("Antigravity CLI runs the hooks and the MCP server from files at the repository root, each with --host=agy", () => {
	const manifest = readJson(".antigravity-plugin/plugin.json");
	for (const field of Object.keys(manifest)) assert.ok(AGY_MANIFEST_FIELDS.includes(field), `agy would drop the manifest field ${field}`);
	assert.equal(typeof manifest.displayName, "string");

	// agy runs a hook with the folder that holds hooks.json as its working directory, and sets no variable that expands in the command.
	const hooks = readJson("hooks.json");
	assert.deepEqual(Object.keys(hooks), ["auto-learn"]);
	const { enabled, ...events } = hooks["auto-learn"];
	assert.equal(enabled, true);
	// PreToolUse is never registered: a hook that prints {} there denies the tool.
	assert.deepEqual(events, {
		SessionStart: [{ type: "command", command: "node ./scripts/hook.mjs session-start --host=agy", timeout: 10 }],
		Stop: [{ type: "command", command: "node ./scripts/hook.mjs stop --host=agy", timeout: 30 }],
	});
	assert.ok(existsSync(path.join(ROOT, "scripts", "hook.mjs")));

	// A server variable would switch the plugin off until a form is filled in.
	assert.deepEqual(readJson("mcp_config.json"), {
		mcpServers: { "auto-learn": { command: "node", args: ["${PLUGIN_ROOT}/scripts/mcp-server.mjs", "--host=agy"], tools: { manage_skill: { eager: true } } } },
	});
	// Copilot CLI would prefer a root plugin.json over .github/plugin/plugin.json.
	assert.equal(existsSync(path.join(ROOT, "plugin.json")), false);
});

test("the Antigravity CLI review agent is the one the runner asks for, is closed to every tool but the plugin's, and is no agent to delegate to", () => {
	const text = readFileSync(path.join(ROOT, "agents", `${REVIEW_AGENT}.md`), "utf8");
	const [, head, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	const fields = Object.fromEntries(head.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
	assert.deepEqual(
		{ ...fields, description: undefined },
		{ name: REVIEW_AGENT, description: undefined, mainAgent: "true", subagent: "false", tools: "[]", inheritMcp: "false" },
	);
	// Claude Code lists a plugin's agents as subagents, and Copilot CLI may offer them.
	assert.match(fields.description, /internal/i);
	assert.match(fields.description, /not for delegat/i);
	assert.match(body, /manage_skill/);
});

test("every prompt has a GitHub Copilot version", () => {
	assert.deepEqual(readdirSync(path.join(ROOT, "prompts", "copilot")).sort(), readdirSync(path.join(ROOT, "prompts")).filter((name) => name.endsWith(".md")).sort());
});

test("every prompt has an Antigravity CLI version", () => {
	assert.deepEqual(readdirSync(path.join(ROOT, "prompts", "agy")).sort(), readdirSync(path.join(ROOT, "prompts")).filter((name) => name.endsWith(".md")).sort());
});

test("every prompt has a Codex version", () => {
	assert.deepEqual(readdirSync(path.join(ROOT, "prompts", "codex")).sort(), readdirSync(path.join(ROOT, "prompts")).filter((name) => name.endsWith(".md")).sort());
});

test("the dependency-free package exports a native OpenCode plugin and ships its runtime files", async () => {
	const manifest = readJson("package.json");
	const { default: plugin } = await import(new URL(`../${manifest.exports["."]}`, import.meta.url));
	assert.equal(plugin.id, "auto-learn");
	assert.equal(typeof plugin.setup, "function");
	assert.deepEqual(manifest.dependencies ?? {}, {});
	for (const name of manifest.files) assert.ok(existsSync(path.join(ROOT, name)), name);
});

test("every prompt has an OpenCode version", () => {
	assert.deepEqual(readdirSync(path.join(ROOT, "prompts", "opencode")).sort(), readdirSync(path.join(ROOT, "prompts")).filter((name) => name.endsWith(".md")).sort());
});
