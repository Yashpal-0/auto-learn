// Stands in for `codex app-server` in tests. It records how it was run and the
// messages it received to $FAKE_CODEX_RECORD, and behaves as $FAKE_CODEX_MODE says:
//   ok        fork the thread, then finish the turn after one manage_skill call
//   create    the same, but run manage_skill through the plugin's MCP server as
//             codex/mcp.json starts it, if the fork's configuration approves it
//             for the plugin $FAKE_CODEX_PLUGIN_ID
//   tools     finish the turn after other tool calls besides manage_skill
//   request   ask the client to approve a command before finishing the turn
//   fail      refuse to fork the thread
//   turn-fail finish the turn as failed
//   exit      exit with an error at initialize
//   hang      never finish the turn
// Like codex, it exits once its stdin closes.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const PLUGIN_ROOT = process.env.FAKE_CODEX_PLUGIN_ROOT || new URL("..", import.meta.url).pathname;
const FORK_ID = "fork-thread";
const FORK_TURN_ID = "fork-turn";
const SESSION_TOTAL = { inputTokens: 50_000, cachedInputTokens: 40_000, outputTokens: 3_000 };
const mode = process.env.FAKE_CODEX_MODE;

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(CLAUDE|PLUGIN_|AUTO_LEARN|CODEX)/.test(key)));
const record = { args: process.argv.slice(2), cwd: process.cwd(), env, received: [] };
const save = () => writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify(record));
save();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params: { threadId: FORK_ID, ...params } });
let fork;
let answerRequest;

const usage = (total, last) => ({ total, last });
const add = (a, b) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + b[key]]));

/** Calls manage_skill through the MCP server, started the way Codex starts it from codex/mcp.json. */
async function callManageSkill(cwd) {
	const { mcpServers } = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "codex", "mcp.json"), "utf8"));
	const server = mcpServers["auto-learn"];
	// Codex passes a plugin's MCP server a few standard variables and the ones it names in env_vars.
	const serverEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
	for (const name of server.env_vars ?? []) if (process.env[name] !== undefined) serverEnv[name] = process.env[name];
	const child = spawn(server.command === "node" ? process.execPath : server.command, server.args, {
		cwd: path.resolve(PLUGIN_ROOT, server.cwd ?? "."),
		env: serverEnv,
		stdio: ["pipe", "pipe", "inherit"],
	});
	const replies = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const call = async (message) => {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		return JSON.parse((await replies.next()).value);
	};
	const init = await call({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const hasSandboxState = init.result.capabilities.experimental?.["codex/sandbox-state"] !== undefined;
	const reply = await call({
		id: 2,
		method: "tools/call",
		params: {
			name: "manage_skill",
			arguments: { action: "create", name: "fake-skill", description: "Use when testing the fake", body: "1. Do it." },
			...(hasSandboxState ? { _meta: { "codex/sandbox-state": { sandboxCwd: pathToFileURL(cwd).href } } } : {}),
		},
	});
	child.stdin.end();
	return reply.result;
}

async function runTurn() {
	notify("turn/started", { turn: { id: FORK_TURN_ID, status: "inProgress" } });
	// Another thread's item, which the fork must not count.
	send({ method: "item/completed", params: { threadId: "another-thread", turnId: "t9", item: { type: "commandExecution", id: "other" } } });
	let total = add(SESSION_TOTAL, { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 30 });
	notify("thread/tokenUsage/updated", { turnId: FORK_TURN_ID, tokenUsage: usage(total, { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 30 }) });
	if (mode === "tools") {
		notify("item/completed", { turnId: FORK_TURN_ID, item: { type: "commandExecution", id: "c1", status: "declined" } });
		notify("item/completed", { turnId: FORK_TURN_ID, item: { type: "webSearch", id: "w1" } });
		notify("item/completed", { turnId: FORK_TURN_ID, item: { type: "mcpToolCall", id: "m1", server: "github", tool: "search_code", status: "failed" } });
	}
	if (mode === "request") {
		const reply = new Promise((resolve) => {
			answerRequest = resolve;
		});
		send({ id: 100, method: "item/commandExecution/requestApproval", params: { threadId: FORK_ID, turnId: FORK_TURN_ID, itemId: "c1" } });
		record.requestReply = await reply;
		save();
	}
	const approval = fork.config?.[`plugins.${process.env.FAKE_CODEX_PLUGIN_ID}.mcp_servers.auto-learn.tools.manage_skill.approval_mode`];
	if (mode === "create" && approval === "approve" && fork.approvalPolicy === "never") record.toolResult = await callManageSkill(fork.cwd);
	save();
	notify("item/completed", { turnId: FORK_TURN_ID, item: { type: "mcpToolCall", id: "m2", server: "auto-learn", tool: "manage_skill", status: "completed" } });
	total = add(total, { inputTokens: 1500, cachedInputTokens: 1400, outputTokens: 50 });
	notify("thread/tokenUsage/updated", { turnId: FORK_TURN_ID, tokenUsage: usage(total, { inputTokens: 1500, cachedInputTokens: 1400, outputTokens: 50 }) });
	if (mode === "hang") return;
	const ending = mode === "turn-fail" ? { status: "failed", error: { message: "You've hit your usage limit." } } : { status: "completed", error: null };
	notify("turn/completed", { turn: { id: FORK_TURN_ID, ...ending } });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
	const message = JSON.parse(line);
	record.received.push(message);
	save();
	if (message.method === undefined) {
		answerRequest?.(message);
		return;
	}
	switch (message.method) {
		case "initialize":
			if (mode === "exit") {
				process.stderr.write("Error loading config.toml: invalid type\n");
				process.exit(3);
			}
			send({ id: message.id, result: { userAgent: "fake-codex/0.168.0", codexHome: "/codex-home", platformFamily: "unix", platformOs: "linux" } });
			break;
		case "thread/fork":
			if (mode === "fail") {
				send({ id: message.id, error: { code: -32600, message: `no rollout found for thread id ${message.params.threadId}` } });
				break;
			}
			fork = message.params;
			send({ id: message.id, result: { thread: { id: FORK_ID, ephemeral: true }, model: fork.model ?? "gpt-default", cwd: fork.cwd } });
			// The forked thread's running total starts from the session's, as reported for the session's last turn.
			notify("thread/tokenUsage/updated", { turnId: message.params.lastTurnId, tokenUsage: usage(SESSION_TOTAL, { inputTokens: 900, cachedInputTokens: 0, outputTokens: 10 }) });
			break;
		case "turn/start":
			send({ id: message.id, result: { turn: { id: FORK_TURN_ID, status: "inProgress", items: [] } } });
			runTurn();
			break;
		default:
			break;
	}
});
