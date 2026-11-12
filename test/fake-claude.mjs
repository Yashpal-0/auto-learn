// Stands in for the claude CLI in tests. It records how it was run to
// $FAKE_CLAUDE_RECORD and behaves as $FAKE_CLAUDE_MODE says:
//   ok      print a successful result
//   create  call manage_skill through the plugin's MCP server, then print a result
//   tools   print a reply that calls the advisor, a refused tool and the allowed ones
//   fail    print an error result and exit 1
//   garbage print text that is not JSON
//   hang    never finish
// With --verbose it prints every message as one JSON array, as claude does.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const MCP_SERVER_SCRIPT = new URL("../scripts/mcp-server.mjs", import.meta.url).pathname;
const MANAGE_SKILL_TOOL = "mcp__plugin_auto-learn_auto-learn__manage_skill";

const args = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
const env = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => /^(CLAUDE|AUTO_LEARN)/.test(key) || key === "AI_AGENT" || key === "TRACEPARENT"),
);
writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, stdin, cwd: process.cwd(), env }));

const result = (fields = {}) => ({
	type: "result",
	subtype: "success",
	is_error: false,
	num_turns: 2,
	result: "",
	total_cost_usd: 0.0123,
	usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 20 },
	...fields,
});

function print(messages) {
	const output = args.includes("--verbose") ? [{ type: "system", subtype: "init" }, ...messages] : messages.at(-1);
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function createSkillThroughMcp() {
	const child = spawn(process.execPath, [MCP_SERVER_SCRIPT], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
	const replies = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
	await replies.next();
	send({ method: "notifications/initialized" });
	send({
		id: 2,
		method: "tools/call",
		params: {
			name: "manage_skill",
			arguments: { action: "create", name: "fake-skill", description: "Use when testing the fake", body: "1. Do it." },
		},
	});
	await replies.next();
	child.stdin.end();
}

switch (process.env.FAKE_CLAUDE_MODE) {
	case "ok":
		print([result()]);
		break;
	case "create":
		await createSkillThroughMcp();
		print([result()]);
		break;
	case "tools":
		print([
			{
				type: "assistant",
				message: {
					content: [
						{ type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
						{ type: "tool_use", id: "toolu_1", name: "ToolSearch", input: { query: `select:${MANAGE_SKILL_TOOL}` } },
						{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "make deploy" } },
						{ type: "tool_use", id: "toolu_3", name: MANAGE_SKILL_TOOL, input: { action: "delete", name: "x" } },
					],
				},
			},
			result(),
		]);
		break;
	case "fail":
		print([result({ subtype: "error_during_execution", is_error: true, result: "Invalid API key" })]);
		process.exitCode = 1;
		break;
	case "garbage":
		process.stdout.write("this is not json\n");
		break;
	case "hang":
		setInterval(() => {}, 1000);
		break;
	default:
		throw new Error(`unknown FAKE_CLAUDE_MODE ${process.env.FAKE_CLAUDE_MODE}`);
}
