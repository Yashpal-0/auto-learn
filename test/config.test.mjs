import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dataDir, displayPath, loadOptions, parseHost, skillsDir } from "../scripts/lib/config.mjs";

test("options fall back to the manifest defaults", () => {
	assert.deepEqual(loadOptions({}), { autoCapture: true, minToolCalls: 5 });
});

test("options read the values Claude Code exports to hooks", () => {
	const off = { CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "false", CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "0" };
	assert.deepEqual(loadOptions(off), { autoCapture: false, minToolCalls: 0 });
	const on = { CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: " TRUE ", CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "12" };
	assert.deepEqual(loadOptions(on), { autoCapture: true, minToolCalls: 12 });
});

test("malformed option values fall back to the defaults", () => {
	const bad = { CLAUDE_PLUGIN_OPTION_AUTOCAPTURE: "yes", CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "-1" };
	assert.deepEqual(loadOptions(bad), { autoCapture: true, minToolCalls: 5 });
	assert.equal(loadOptions({ CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: "2.5" }).minToolCalls, 5);
	assert.equal(loadOptions({ CLAUDE_PLUGIN_OPTION_MINTOOLCALLS: " " }).minToolCalls, 5);
});

test("the skill library follows CLAUDE_CONFIG_DIR unless AUTO_LEARN_SKILLS_DIR names one", () => {
	assert.equal(skillsDir({}), path.join(os.homedir(), ".claude", "skills"));
	assert.equal(skillsDir({ CLAUDE_CONFIG_DIR: "/cfg" }), path.resolve("/cfg/skills"));
	assert.equal(skillsDir({ CLAUDE_CONFIG_DIR: "/cfg", AUTO_LEARN_SKILLS_DIR: "/elsewhere" }), path.resolve("/elsewhere"));
});

test("Codex's skill library is ~/.agents/skills, which Codex discovers, unless AUTO_LEARN_SKILLS_DIR names one", () => {
	assert.equal(skillsDir({ CLAUDE_CONFIG_DIR: "/cfg" }, "codex"), path.join(os.homedir(), ".agents", "skills"));
	assert.equal(skillsDir({ AUTO_LEARN_SKILLS_DIR: "/elsewhere" }, "codex"), path.resolve("/elsewhere"));
});

test("OpenCode's skill library follows XDG_CONFIG_HOME and stays separate from Claude and Codex", () => {
	assert.equal(skillsDir({}, "opencode"), path.join(os.homedir(), ".config", "opencode", "skills"));
	assert.equal(skillsDir({ XDG_CONFIG_HOME: "/cfg", CLAUDE_CONFIG_DIR: "/claude" }, "opencode"), path.resolve("/cfg/opencode/skills"));
	assert.equal(skillsDir({ AUTO_LEARN_SKILLS_DIR: "/elsewhere" }, "opencode"), path.resolve("/elsewhere"));
});

test("the host is Claude Code without arguments and Codex with --host=codex; anything else is refused", () => {
	assert.equal(parseHost([]), "claude");
	assert.equal(parseHost(["--host=codex"]), "codex");
	for (const args of [["--host=claude"], ["--host", "codex"], ["--host=codex", "extra"], ["codex"]]) {
		assert.throws(() => parseHost(args), /Unknown arguments/, JSON.stringify(args));
	}
});

test("plugin state lives in CLAUDE_PLUGIN_DATA", () => {
	assert.equal(dataDir({ CLAUDE_PLUGIN_DATA: "/plugin-data" }), path.resolve("/plugin-data"));
	assert.equal(dataDir({ CLAUDE_CONFIG_DIR: "/cfg" }), path.resolve("/cfg/auto-learn"));
});

test("displayPath shows the home directory as ~", () => {
	assert.equal(displayPath("/home/u/.claude/skills/x", "/home/u"), path.join("~", ".claude", "skills", "x"));
	assert.equal(displayPath("/home/u/..x/y", "/home/u"), path.join("~", "..x", "y"));
	assert.equal(displayPath("/home/user2/x", "/home/u"), "/home/user2/x");
	assert.equal(displayPath("/home/u", "/home/u"), "/home/u");
});
