import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await fs.mkdtemp("/tmp/opencode/auto-learn-live-");
const project = path.join(root, "project");
const config = path.join(root, "config", "opencode");
const library = path.join(config, "skills");
const logDir = path.join(root, "data", "opencode", "auto-learn");
const password = randomBytes(24).toString("hex");
const manual = { action: "create", name: "live-manual", description: "Use when testing manual native saves", body: "Run the verified manual fixture." };
const automatic = { action: "create", name: "live-automatic", description: "Use when testing automatic native saves", body: "Run the verified automatic fixture." };
const observed = { main: 0, review: 0, reviewTools: [], reviewSystem: "" };
let server;
let serverOutput = "";
let succeeded = false;

const provider = http.createServer(async (req, res) => {
	try {
		assert.equal(req.url, "/v1/chat/completions");
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const last = input.messages.at(-1);
		const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
		const review = text?.includes("Automatic skill review from the auto-learn plugin");
		const hasResult = input.messages.some((message) => message.role === "tool");
		let message = { role: "assistant", content: "Auto-learn fixture completed." };
		let finish = "stop";
		if (review) {
			observed.review++;
			observed.reviewTools = input.tools ?? [];
			observed.reviewSystem = JSON.stringify((input.messages ?? []).filter((m) => m.role === "system" || m.role === "developer"));
			message.content = `\`\`\`json\n${JSON.stringify(automatic)}\n\`\`\``;
		} else if (!hasResult && input.tools?.some((tool) => tool.function?.name === "execute")) {
			observed.main++;
			const dir = JSON.stringify(project);
			message = { role: "assistant", content: null, tool_calls: [{
				id: "call_native_save", type: "function", function: {
					name: "execute", arguments: JSON.stringify({ code: [
						`await Promise.all([tools.read({ path: ${dir} }), tools.read({ path: ${dir} }), tools.read({ path: ${dir} }), tools.read({ path: ${dir} })]);`,
						`return await tools.auto_learn.manage_skill(${JSON.stringify(manual)});`,
					].join("\n") }),
				},
			}] };
			finish = "tool_calls";
		}
		const base = { id: "chatcmpl-fixture", created: 1, model: "fixture" };
		const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
		if (input.stream) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const delta = message.tool_calls ? { role: "assistant", tool_calls: message.tool_calls.map((tool, index) => ({ index, ...tool })) } : message;
			res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
			res.end("data: [DONE]\n\n");
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage }));
		}
	} catch (error) {
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: error.message } }));
	}
});

function waitForCapture() {
	const file = path.join(logDir, "auto-learn.log");
	const watcher = watch(logDir);
	let checking = Promise.resolve();
	return new Promise((resolve, reject) => {
		const finish = (error, value) => {
			clearTimeout(timer);
			watcher.close();
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => finish(new Error("Timed out waiting for an automatic capture.")), 30000);
		const check = () => {
			checking = checking.then(async () => {
				let text;
				try { text = await fs.readFile(file, "utf8"); } catch (error) {
					if (error.code === "ENOENT") return;
					throw error;
				}
				const records = text.split("\n").slice(0, -1).map(JSON.parse);
				const result = records.find((record) => record.event === "capture");
				if (result) finish(undefined, result);
			}).catch((error) => finish(error));
		};
		watcher.on("change", check);
		watcher.on("error", (error) => finish(error));
		check();
	});
}

async function stopServer() {
	if (!server || server.exitCode !== null || server.signalCode !== null) return;
	const exited = once(server, "exit");
	const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
	server.kill("SIGTERM");
	try { await exited; } finally { clearTimeout(timer); }
}

try {
	await Promise.all([fs.mkdir(project), fs.mkdir(library, { recursive: true }), fs.mkdir(logDir, { recursive: true })]);
	const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8" }));
	assert.ok(packed.files.some((file) => file.path === ".claude-plugin/plugin.json"));
	execFileSync("tar", ["-xzf", path.join(root, packed.filename), "-C", root]);
	const installed = path.join(root, "package");
	const { default: plugin } = await import(new URL(`file://${installed}/opencode/index.mjs`));
	assert.equal(plugin.id, "auto-learn");
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	await fs.writeFile(path.join(config, "opencode.json"), JSON.stringify({
		$schema: "https://opencode.ai/config.json",
		model: "fixture/fixture",
		update: "disable",
		plugins: [installed],
		permissions: [{ action: "*", resource: "*", effect: "allow" }],
		providers: { fixture: {
			name: "Local test provider", package: "@opencode/ai/providers/openai-compatible",
			settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "local-test", timeout: 10000 },
			models: { fixture: { name: "Fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 65536, output: 8192 } } },
		} },
	}));
	server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
		cwd: project,
		env: {
			PATH: process.env.PATH, HOME: root, TMPDIR: root, NO_COLOR: "1",
			XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
			XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
			OPENCODE_PASSWORD: password,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const url = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("OpenCode did not start within 30 seconds.")), 30000);
		const read = (chunk) => {
			serverOutput = (serverOutput + chunk.toString()).slice(-65536);
			const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serverOutput);
			if (match) { clearTimeout(timer); resolve(match[1]); }
		};
		server.stdout.on("data", read);
		server.stderr.on("data", read);
		server.once("error", (error) => { clearTimeout(timer); reject(error); });
		server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`OpenCode exited before readiness: ${code}.`)); });
	});
	const api = async (method, endpoint, data) => {
		const response = await fetch(`${url}${endpoint}`, {
			method, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
			...(data === undefined ? {} : { body: JSON.stringify(data) }),
			signal: AbortSignal.timeout(30000),
		});
		assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${await response.clone().text()}`);
		return response.status === 204 ? undefined : response.json();
	};
	const locationQuery = `?${new URLSearchParams({ "location[directory]": project })}`;
	const { data: session } = await api("POST", "/api/session", { title: "Auto-learn native smoke", location: { directory: project } });
	const updates = await fetch(`${url}/api/event?types=skill.updated`, {
		headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
		signal: AbortSignal.timeout(30000),
	});
	assert.ok(updates.ok);
	const catalogReady = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of updates.body) {
			buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r", "");
			let boundary;
			while ((boundary = buffer.indexOf("\n\n")) !== -1) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (!frame.includes("data:")) continue;
				const skills = await api("GET", `/api/skill${locationQuery}`);
				if (skills.data.some((skill) => skill.id === "live-automatic")) return;
			}
		}
		throw new Error("Skill event stream ended before discovery completed.");
	})();
	const capture = waitForCapture();
	const completed = Promise.all([capture, catalogReady]);
	completed.catch(() => {});
	await api("POST", `/api/session/${session.id}/prompt`, { text: "Save the verified manual fixture with auto_learn.manage_skill, then finish." });
	await api("POST", `/api/experimental/session/${session.id}/wait`);
	const [result] = await completed;
	assert.equal(result.outcome, "ok", JSON.stringify(result));
	assert.deepEqual(result.created, ["live-automatic"]);
	const plugins = await api("GET", `/api/plugin${locationQuery}`);
	assert.ok(plugins.data.some((item) => item.id === "auto-learn"), JSON.stringify(plugins));
	for (const name of ["live-manual", "live-automatic"]) {
		assert.match(await fs.readFile(path.join(library, name, "SKILL.md"), "utf8"), /verified .* fixture/);
		await fs.access(path.join(library, name, ".auto-learn"));
	}
	const skills = await api("GET", `/api/skill${locationQuery}`);
	assert.ok(skills.data.some((skill) => skill.id === "live-automatic"));
	assert.equal(observed.main, 1);
	assert.equal(observed.review, 1);
	assert.deepEqual(observed.reviewTools, []);
	assert.match(observed.reviewSystem, /# Skill library/);
	console.log(JSON.stringify({ package: `${packed.name}@${packed.version}`, nativePlugin: true, manualSave: true, automaticSave: true, reviewTools: observed.reviewTools, capture: result }));
	succeeded = true;
} catch (error) {
	console.error(`OpenCode live check failed; artifacts kept at ${root}.`);
	console.error(serverOutput.slice(-6000));
	throw error;
} finally {
	await stopServer();
	provider.closeAllConnections();
	await new Promise((resolve) => provider.close(resolve));
	if (succeeded) await fs.rm(root, { recursive: true, force: true });
}
