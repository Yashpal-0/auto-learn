#!/usr/bin/env node
// Claude Code and Codex run this for each plugin hook:
// `hook.mjs <session-start|stop|session-end> [--host=codex]`, with the hook
// input as JSON on stdin.
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
	if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
	process.stderr.write(`auto-learn: ${error.message}\n`);
	process.exitCode = 1;
}
