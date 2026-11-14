// Plugin options and filesystem locations shared by the hooks, the capture worker and the MCP server.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const manifest = JSON.parse(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"));

export const PLUGIN_VERSION = manifest.version;

/**
 * The user's plugin options. Claude Code exports each saved option to hooks as
 * CLAUDE_PLUGIN_OPTION_<KEY>; an unset or malformed value falls back to the
 * manifest default, the single home of every default.
 */
export function loadOptions(env = process.env) {
	const fields = manifest.userConfig;
	return {
		autoCapture: parseBoolean(env.CLAUDE_PLUGIN_OPTION_AUTOCAPTURE) ?? fields.autoCapture.default,
		minToolCalls: parseCount(env.CLAUDE_PLUGIN_OPTION_MINTOOLCALLS) ?? fields.minToolCalls.default,
	};
}

function parseBoolean(raw) {
	const value = raw?.trim().toLowerCase();
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function parseCount(raw) {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The agent a hook or the MCP server runs for, from its command-line
 * arguments: none for Claude Code, `--host=codex` for Codex.
 *
 * @returns {"claude" | "codex"}
 */
export function parseHost(args) {
	if (args.length === 0) return "claude";
	if (args.length === 1 && args[0] === "--host=codex") return "codex";
	throw new Error(`Unknown arguments ${JSON.stringify(args)}: expected nothing or --host=codex.`);
}

function claudeConfigDir(env) {
	return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * The personal skills directory the agent discovers, which holds the managed
 * skills: ~/.claude/skills, ~/.agents/skills, or $XDG_CONFIG_HOME/opencode/skills.
 */
export function skillsDir(env = process.env, host = "claude") {
	if (env.AUTO_LEARN_SKILLS_DIR) return path.resolve(env.AUTO_LEARN_SKILLS_DIR);
	if (host === "opencode") return path.resolve(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "skills");
	return path.resolve(host === "codex" ? path.join(os.homedir(), ".agents", "skills") : path.join(claudeConfigDir(env), "skills"));
}

/** Claude Code's user settings, settings.json in its configuration folder. */
export function claudeUserSettingsFile(env = process.env) {
	return path.join(claudeConfigDir(env), "settings.json");
}

/** Plugin state: the capture queue, locks, turn offsets and the activity log. */
export function dataDir(env = process.env) {
	return path.resolve(env.CLAUDE_PLUGIN_DATA || path.join(claudeConfigDir(env), "auto-learn"));
}

/**
 * Claude Code's global configuration, where it records each project's last
 * session and what that session cost. It sits beside ~/.claude, not in it.
 */
// shortcut: skips the legacy ~/.claude/.config.json and the OAuth-suffixed names Claude Code may read instead, so their users get claude's own total; read them when someone needs it.
export function claudeGlobalConfigFile(env = process.env, home = os.homedir()) {
	return path.join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
}

/** A path for messages and prompts, with the home directory shown as ~. */
export function displayPath(target, home = os.homedir()) {
	const relative = path.relative(home, target);
	if (relative === "" || path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") return target;
	return path.join("~", relative);
}
