// Stands in for the `copilot` CLI in tests. It appends what it receives to
// $FAKE_COPILOT_RECORD, one JSON line per entry, with its whole environment, and serves two commands:
//   copilot -p <prompt> --resume <id> ...   records its arguments, working
//     directory, environment and session <id> in $COPILOT_HOME/session-state,
//     takes the session's operation lock as Copilot does, which it leaves
//     behind, then reviews the session as $FAKE_COPILOT_MODE says:
//       ok       one manage_skill call that saves a skill
//       refused  one manage_skill call that fails, and a call to a hidden tool
//       exit     exit with an error
//       hang     never exit
//       stubborn ignores SIGTERM, and exits on its own after 5 seconds
//       polite   never exit, but exits with 0 on SIGTERM
//   copilot --headless --stdio   answers JSON-RPC with Content-Length framing:
//     sends a notification and asks the client something before it connects,
//     then deletes the session's folder, or refuses to when
//     $FAKE_COPILOT_DELETE is "fail". It exits once its stdin closes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const stateDir = path.join(process.env.COPILOT_HOME, "session-state");
const record = (entry) => appendFileSync(process.env.FAKE_COPILOT_RECORD, `${JSON.stringify(entry)}\n`);
// The whole environment, so a test can see every variable that reached the review.
const env = { ...process.env };

if (args.includes("--headless")) headless();
else review();

function review() {
	const id = args[args.indexOf("--resume") + 1];
	const dir = path.join(stateDir, id);
	const events = path.join(dir, "events.jsonl");
	record({
		command: "review",
		args,
		cwd: process.cwd(),
		env,
		copy: readFileSync(events, "utf8"),
		workspace: existsSync(path.join(dir, "workspace.yaml")) ? readFileSync(path.join(dir, "workspace.yaml"), "utf8") : null,
		lock: existsSync(path.join(dir, ".workspace-fork.lock")),
	});
	mkdirSync(path.join(stateDir, ".session-operation-locks"), { recursive: true });
	writeFileSync(path.join(stateDir, ".session-operation-locks", `${id}.lock`), "");
	const mode = process.env.FAKE_COPILOT_MODE;
	if (mode === "exit") {
		process.stderr.write("Error: No model available. Check your Copilot subscription.\n");
		process.exit(3);
	}
	if (mode === "hang" || mode === "stubborn" || mode === "polite") {
		if (mode === "stubborn") {
			process.on("SIGTERM", () => {});
			setTimeout(() => process.exit(0), 5000);
		}
		if (mode === "polite") process.on("SIGTERM", () => process.exit(0));
		setInterval(() => {}, 1000);
		return;
	}
	let count = 0;
	const event = (type, data) => JSON.stringify({ type, data, id: `review-${++count}`, timestamp: "2026-11-19T10:05:00.000Z", parentId: null });
	const usage = (sourceSessionId, nanoAiu, inputTokens, cacheReadTokens, outputTokens) =>
		event("session.usage_record", { usage: { inputTokens, cacheReadTokens, outputTokens, copilotUsage: { totalNanoAiu: nanoAiu }, accounting: { sourceSessionId } } });
	const calls =
		mode === "refused"
			? [
					["c1", "auto-learn-manage_skill", { action: "create", name: "Not A Name", description: "x", body: "y" }, false],
					["c2", "bash", { command: "cat ~/.aws/credentials" }, false],
				]
			: [["c1", "auto-learn-manage_skill", { action: "create", name: "fake-skill", description: "Use when testing the fake", body: "1. Do it." }, true]];
	const lines = [
		event("session.resume", { resumeTime: "2026-11-19T10:05:00.000Z" }),
		event("user.message", { content: args[args.indexOf("-p") + 1] }),
		event("assistant.turn_start", { turnId: "0", agentMode: "interactive" }),
		usage(id, 100_000_000, 2000, 0, 50),
		// A request on another session's account, which is not the review's.
		usage("another-session", 999_000_000_000, 1, 1, 1),
		...calls.flatMap(([toolCallId, toolName, input, success]) => [
			event("tool.execution_start", { toolCallId, toolName, arguments: input }),
			event("tool.execution_complete", { toolCallId, success }),
		]),
		event("assistant.turn_end", { turnId: "0" }),
		event("assistant.turn_start", { turnId: "1", agentMode: "interactive" }),
		usage(id, 23_456_789, 2100, 1900, 10),
		event("assistant.message", { content: "" }),
		event("assistant.turn_end", { turnId: "1" }),
	];
	appendFileSync(events, lines.map((line) => `${line}\n`).join(""));
}

function headless() {
	record({ command: "headless", args, env });
	const send = (message) => {
		const body = JSON.stringify({ jsonrpc: "2.0", ...message });
		process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};
	const handle = (message) => {
		record({ received: message });
		if (message.method === "connect") {
			send({ method: "session.lifecycle", params: { type: "ready" } });
			send({ id: "server-1", method: "client.capabilities", params: {} });
			send({ id: message.id, result: { protocolVersion: 1 } });
		} else if (message.method === "session.delete") {
			if (process.env.FAKE_COPILOT_DELETE === "fail") {
				send({ id: message.id, error: { code: -32603, message: "Session is in use" } });
				return;
			}
			rmSync(path.join(stateDir, message.params.sessionId), { recursive: true, force: true });
			send({ id: message.id, result: {} });
		}
	};
	let buffer = Buffer.alloc(0);
	process.stdin.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
			if (buffer.length < headerEnd + 4 + length) return;
			const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
			buffer = buffer.subarray(headerEnd + 4 + length);
			handle(JSON.parse(body));
		}
	});
	process.stdin.on("end", () => process.exit(0));
}
