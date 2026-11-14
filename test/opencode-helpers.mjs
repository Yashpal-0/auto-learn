import fs from "node:fs/promises";
import path from "node:path";
import { addAbortSignal, PassThrough } from "node:stream";
import { learnedSkills } from "../scripts/lib/skills.mjs";
import { tempDir } from "./helpers.mjs";

export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

export async function nativeHost(t) {
	const root = await tempDir(t);
	const library = path.join(root, "skills");
	const project = path.join(root, "project");
	await fs.mkdir(project);
	const env = { AUTO_LEARN_SKILLS_DIR: library, XDG_DATA_HOME: path.join(root, "data") };
	const hooks = { session: new Map(), permission: new Map() };
	const tools = new Map();
	const storage = new Map();
	const events = new PassThrough({ objectMode: true });
	const saved = deferred();
	const generated = deferred();
	const finished = deferred();
	const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
	const session = { id: "ses_native", projectID: "project", agent: "build", cost: 0, tokens, time: { created: 1, updated: 1 }, location: { directory: project } };
	const host = { root, library, project, env, hooks, tools, storage, events, saved, generated, finished, session, catalog: [], messages: [], generations: 0, prompts: 0 };
	const register = (domain) => async (name, callback) => {
		hooks[domain].set(name, callback);
		return { dispose: async () => hooks[domain].delete(name) };
	};
	const ctx = {
		options: {},
		location: { directory: project },
		tool: { transform: async (callback) => callback({ namespace() {}, add: (tool) => tools.set(tool.name, tool) }) },
		session: {
			hook: register("session"),
			get: async () => session,
			context: async () => host.messages,
			generate: async (input) => {
				host.generations++;
				const request = { ...input, system: [], messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }], tools: { shell: {}, execute: {} }, options: {} };
				await hooks.session.get("generate")?.(request);
				generated.resolve(request);
				host.onGenerate?.(request);
				return host.response ?? { text: "null", cost: 0, tokens };
			},
		},
		skill: {
			list: async () => ({ location: { directory: project }, data: [...host.catalog, ...await Promise.all((await learnedSkills(library)).map(async ({ name, description }) => ({
				id: name, name, description, path: path.join(library, name, "SKILL.md"),
				content: await fs.readFile(path.join(library, name, "SKILL.md"), "utf8"),
			})))] }),
			reload: async () => saved.resolve(),
		},
		permission: {
			hook: register("permission"),
			assert: async (input) => {
				if (host.permission === "deny") throw new Error("Permission denied");
				const event = { ...input, effect: host.permission ?? "allow" };
				await hooks.permission.get("evaluate")?.(event);
				if (event.effect === "ask") host.prompts++;
				if (event.effect !== "allow") throw new Error(`Permission ${event.effect}`);
			},
		},
		storage: {
			get: async (key) => storage.get(key),
			set: async (key, value) => { storage.set(key, value); if (key.startsWith("reviewed/")) finished.resolve(); },
			remove: async (key) => storage.delete(key),
		},
		event: { subscribe: ({ signal, types }) => (async function* () {
			for await (const item of addAbortSignal(signal, events)) {
				if (!types || types.includes(item.event.type)) yield item.event;
				item.handled.resolve();
			}
		})() },
	};
	host.ctx = ctx;
	host.send = (event) => {
		const handled = deferred();
		events.write({ event, handled });
		return handled.promise;
	};
	t.after(() => events.destroy());
	return host;
}

export function completedTurn(count = 5, agent = "build", id = "turn") {
	return [
		{ id: `msg_${id}_user`, type: "user", text: "Find the build recipe", time: { created: 1 } },
		{ id: `msg_${id}_assistant`, type: "assistant", agent, content: [
			...Array.from({ length: count }, (_, n) => ({ type: "tool", id: `call_${n}`, name: "shell", state: { status: "completed", input: { command: "build" }, content: [{ type: "text", text: "ok" }] } })),
			{ type: "text", text: "The build works." },
		], time: { created: 2, completed: 3 } },
		{ id: `msg_${id}`, type: "idle", outcome: "succeeded", time: { created: 4 } },
	];
}

export function successEvent(project, id = "turn") {
	return { id: `evt_${id}`, type: "session.execution.succeeded", created: 4, data: { sessionID: "ses_native" }, location: { directory: project }, durable: { aggregateID: "ses_native", seq: 10, version: 1 } };
}

export const proposal = { action: "create", name: "native-build", description: "Use when building this project", body: "Run the verified build command." };
