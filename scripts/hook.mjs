#!/usr/bin/env node
// Claude Code, Codex, GitHub Copilot and Antigravity CLI run this for each
// plugin hook: `hook.mjs <session-start|stop|session-end> [--host=codex|
// --host=copilot|--host=agy]`, with the hook input as JSON on stdin.
import { parseHost } from "./lib/config.mjs";
import { runHook } from "./lib/hook.mjs";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

async function readInput() {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > MAX_INPUT_BYTES) throw new Error("The hook input is larger than 16 MiB.");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("The hook input is not valid JSON.");
	}
}

try {
	const host = parseHost(process.argv.slice(3));
	const output = await runHook(process.argv[2], await readInput(), { host });
	// agy reads a hook's output as one JSON object, and {} says there is nothing to add.
	if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
	else if (host === "agy") process.stdout.write("{}\n");
} catch (error) {
	process.stderr.write(`auto-learn: ${error.message}\n`);
	process.exitCode = 1;
}
