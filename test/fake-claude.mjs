// Stands in for the claude CLI in tests. It records how it was run to
// $FAKE_CLAUDE_RECORD and behaves as $FAKE_CLAUDE_MODE says:
//   ok      reply, then print a successful result
//   create  save a skill through the plugin's MCP server, then print a result
//   overlap as create, while another session saves a skill of its own
//   tools   call the advisor, the allowed tools and refused ones, then print a result
//   huge    print a 9 MiB line that calls a refused tool, then a reply that calls another
//   stall   save a skill in its first reply, then never finish
//   linger  reply and print a successful result, then never finish
//   fail    print an error result and exit 1
//   garbage print text that is not JSON
//   hang    never finish
// Like claude 2.1.325 with --output-format stream-json --verbose, it prints
// each message as a JSON line, and each content block of a reply as a line of
// its own that carries the reply's id and usage. Like claude, it counts the
// last cost-state entry that the resumed session's transcript
// ($FAKE_CLAUDE_TRANSCRIPT) holds for the session into its totals, unless
// $FAKE_CLAUDE_RESTORE is off. In stall and linger modes it creates
// $FAKE_CLAUDE_RECORD.printed once all it prints is out.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
import { manageSkill } from "../scripts/lib/skills.mjs";

const MCP_SERVER_SCRIPT = new URL("../scripts/mcp-server.mjs", import.meta.url).pathname;
const MANAGE_SKILL_TOOL = "mcp__plugin_auto-learn_auto-learn__manage_skill";
/** A tool name too long to log whole, which tools mode calls. */
const LONG_TOOL_NAME = `mcp__wide__${"x".repeat(300)}`;

const args = process.argv.slice(2);
const flagValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
if (flagValue("--output-format") !== "stream-json" || !args.includes("--verbose")) {
	throw new Error("fake-claude prints only --output-format stream-json with --verbose, which is how runFork runs claude.");
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
const env = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => /^(CLAUDE|AUTO_LEARN)/.test(key) || key === "AI_AGENT" || key === "TRACEPARENT"),
);
writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, stdin, cwd: process.cwd(), env }));

const OWN_COST_USD = 0.0123;
const USAGE = { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 20 };
const model = flagValue("--model") ?? "claude-test-1";
const SESSION_ID = "fork-session";

/** The resumed session's last cost-state entry, which claude restores its cost counters from. */
function restoredCost() {
	let restored = { totalCostUSD: 0, modelUsage: {} };
	if (process.env.FAKE_CLAUDE_RESTORE === "off") return restored;
	for (const line of readFileSync(process.env.FAKE_CLAUDE_TRANSCRIPT, "utf8").split("\n")) {
		const value = line.includes('"cost-state"') ? JSON.parse(line) : undefined;
		if (value?.type === "cost-state" && value.sessionId === flagValue("--resume")) restored = value;
	}
	return restored;
}

const restored = restoredCost();
const result = (fields = {}) => ({
	type: "result",
	subtype: "success",
	is_error: false,
	num_turns: 2,
	result: "",
	total_cost_usd: restored.totalCostUSD + OWN_COST_USD,
	usage: USAGE,
	modelUsage: { ...restored.modelUsage, [model]: { costUSD: (restored.modelUsage[model]?.costUSD ?? 0) + OWN_COST_USD } },
	session_id: SESSION_ID,
	...fields,
});

function print(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

let replies = 0;

/** Prints a reply as claude does: a line per content block, each carrying the reply's id and usage. */
function reply(blocks, usage = USAGE) {
	const id = `msg_${++replies}`;
	for (const block of blocks) {
		const message = { id, type: "message", role: "assistant", model, content: [block], usage };
		print({ type: "assistant", message, parent_tool_use_id: null, session_id: SESSION_ID });
	}
}

function toolResult(toolUseId, content, isError) {
	const block = { type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
	print({ type: "user", message: { role: "user", content: [block] }, parent_tool_use_id: null, session_id: SESSION_ID });
}

/** Runs a manage_skill call through the plugin's MCP server, as claude does, and prints its result. */
async function callManageSkill(toolUseId, input) {
	const child = spawn(process.execPath, [MCP_SERVER_SCRIPT], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
	const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
	await lines.next();
	send({ method: "notifications/initialized" });
	send({ id: 2, method: "tools/call", params: { name: "manage_skill", arguments: input } });
	const called = JSON.parse((await lines.next()).value).result;
	child.stdin.end();
	toolResult(toolUseId, called.content, called.isError === true);
}

/** A reply that saves `skill`, the skill saved, and the call's result. */
async function save(skill, usage) {
	const input = { description: "Use when testing the fake", body: "1. Do it.", ...skill };
	const call = { type: "tool_use", id: "toolu_save", name: MANAGE_SKILL_TOOL, input };
	reply([{ type: "text", text: "I will save what this turn taught." }, call], usage);
	await callManageSkill(call.id, call.input);
}

const INIT = { type: "system", subtype: "init", session_id: SESSION_ID, model };
const signalPrinted = () => process.stdout.write("", () => writeFileSync(`${process.env.FAKE_CLAUDE_RECORD}.printed`, ""));

switch (process.env.FAKE_CLAUDE_MODE) {
	case "ok":
		print(INIT);
		reply([{ type: "text", text: "Nothing in this turn is worth saving." }]);
		print(result());
		break;
	case "create":
		print(INIT);
		await save({ action: "create", name: "fake-skill" });
		print(result());
		break;
	case "overlap":
		print(INIT);
		await manageSkill(
			{ action: "create", name: "other-skill", description: "Use when testing another session", body: "1. Do it." },
			{ skillsDir: process.env.AUTO_LEARN_SKILLS_DIR },
		);
		await save({ action: "create", name: "fake-skill" });
		print(result());
		break;
	case "tools": {
		print(INIT);
		const refused = ["Bash", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", LONG_TOOL_NAME, "mcp__github__create_issue"];
		reply([
			{ type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
			{ type: "tool_use", id: "toolu_search", name: "ToolSearch", input: { query: `select:${MANAGE_SKILL_TOOL}` } },
			...refused.map((name, index) => ({ type: "tool_use", id: `toolu_refused_${index}`, name, input: {} })),
			{ type: "tool_use", id: "toolu_failed", name: MANAGE_SKILL_TOOL, input: { action: "delete", name: "missing-skill" } },
			{ type: "tool_use", id: "toolu_odd", name: MANAGE_SKILL_TOOL, input: { action: "rename", name: "fake-skill" } },
		]);
		toolResult("toolu_search", [{ type: "tool_reference", tool_name: MANAGE_SKILL_TOOL }], false);
		refused.forEach((_, index) => toolResult(`toolu_refused_${index}`, "Only manage_skill can run during an automatic skill review.", true));
		await callManageSkill("toolu_failed", { action: "delete", name: "missing-skill" });
		// An action the store does not know, answered as if it had worked, as a later store might.
		toolResult("toolu_odd", [{ type: "text", text: "Renamed." }], false);
		print(result());
		break;
	}
	case "huge": {
		print(INIT);
		const content = [
			{ type: "text", text: "x".repeat(9 * 1024 * 1024) },
			{ type: "tool_use", id: "toolu_huge", name: "Bash", input: {} },
		];
		print({ type: "assistant", message: { id: "msg_huge", type: "message", role: "assistant", model, content, usage: USAGE }, session_id: SESSION_ID });
		reply([{ type: "tool_use", id: "toolu_read", name: "Read", input: {} }]);
		print(result());
		break;
	}
	case "stall":
		print(INIT);
		await save(
			{ action: "create", name: "stalled-skill" },
			{ input_tokens: 40, cache_creation_input_tokens: 4, cache_read_input_tokens: 2, output_tokens: 8 },
		);
		signalPrinted();
		setInterval(() => {}, 1000);
		break;
	case "linger":
		print(INIT);
		reply([{ type: "text", text: "Nothing in this turn is worth saving." }]);
		print(result());
		signalPrinted();
		setInterval(() => {}, 1000);
		break;
	case "fail":
		print(INIT);
		print(result({ subtype: "error_during_execution", is_error: true, result: "Invalid API key" }));
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
