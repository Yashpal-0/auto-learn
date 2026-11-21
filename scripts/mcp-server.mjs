#!/usr/bin/env node
// The auto-learn MCP server: newline-delimited JSON-RPC 2.0 on stdin and
// stdout. `mcp-server.mjs` serves Claude Code, `mcp-server.mjs --host=codex`
// Codex, `mcp-server.mjs --host=copilot` GitHub Copilot and
// `mcp-server.mjs --host=agy` Antigravity CLI.
import readline from "node:readline";
import { agyBuiltinSkillsDirs, parseHost, skillsDir } from "./lib/config.mjs";
import { createMcpServer } from "./lib/mcp.mjs";

let host;
try {
	host = parseHost(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`auto-learn: ${error.message}\n`);
	process.exit(1);
}
// Codex starts the server in the plugin's folder and names each call's project in the call itself; Copilot names the session's folder in COPILOT_SESSION_CWD, and reads ~/.agents/skills, Codex's folder, besides its own; agy names the project of a review in AUTO_LEARN_PROJECT_DIR, which the review's worker sets, and refuses the names of its builtin skills.
const contexts = {
	codex: () => ({ skillsDir: skillsDir(process.env, host), host }),
	copilot: () => ({ skillsDir: skillsDir(process.env, host), projectDir: process.env.COPILOT_SESSION_CWD || undefined, agentsSkillsDir: skillsDir({}, "codex"), host }),
	agy: () => ({ skillsDir: skillsDir(process.env, host), projectDir: process.env.AUTO_LEARN_PROJECT_DIR || process.cwd(), builtinSkillsDirs: agyBuiltinSkillsDirs(), host }),
	claude: () => ({ skillsDir: skillsDir(), projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd() }),
};
const handle = createMcpServer(contexts[host]());

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

// One request at a time, so two calls never write the same skill at once.
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!line.trim()) continue;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		continue;
	}
	try {
		const reply = await handle(message);
		if (reply) write(reply);
	} catch (error) {
		write({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: `Internal error: ${error.message}` } });
	}
}
