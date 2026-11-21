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

/** The agents named by `--host=<name>`; Claude Code is the one that gets no argument. */
const FLAG_HOSTS = ["codex", "copilot"];

/**
 * The agent a hook or the MCP server runs for, from its command-line
 * arguments: none for Claude Code, `--host=codex` for Codex, `--host=copilot`
 * for GitHub Copilot.
 *
 * @returns {"claude" | "codex" | "copilot"}
 */
export function parseHost(args) {
	if (args.length === 0) return "claude";
	const host = args.length === 1 ? FLAG_HOSTS.find((name) => args[0] === `--host=${name}`) : undefined;
	if (host) return host;
	const expected = ["nothing", ...FLAG_HOSTS.map((name) => `--host=${name}`)];
	throw new Error(`Unknown arguments ${JSON.stringify(args)}: expected ${expected.slice(0, -1).join(", ")} or ${expected.at(-1)}.`);
}

function claudeConfigDir(env) {
	return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** GitHub Copilot's configuration and state folder, which holds its skills and sessions. */
export function copilotHome(env = process.env) {
	return path.resolve(env.COPILOT_HOME || path.join(os.homedir(), ".copilot"));
}

/**
 * The personal skills directory the agent discovers, which holds the managed
 * skills: ~/.claude/skills, ~/.agents/skills, ~/.copilot/skills, or
 * $XDG_CONFIG_HOME/opencode/skills.
 */
export function skillsDir(env = process.env, host = "claude") {
	if (env.AUTO_LEARN_SKILLS_DIR) return path.resolve(env.AUTO_LEARN_SKILLS_DIR);
	if (host === "opencode") return path.resolve(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode", "skills");
	if (host === "copilot") return path.join(copilotHome(env), "skills");
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

/** A path for messages and prompts, with the home directory shown as ~. */
export function displayPath(target, home = os.homedir()) {
	const relative = path.relative(home, target);
	if (relative === "" || path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") return target;
	return path.join("~", relative);
}
