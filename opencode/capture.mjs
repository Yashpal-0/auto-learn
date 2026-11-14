import os from "node:os";
import path from "node:path";
import { captureNudge } from "../scripts/lib/prompts.mjs";
import { appendLog } from "../scripts/lib/state.mjs";

const MAX_REVIEW_BYTES = 256 * 1024;
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ACTIVE_REVIEWS = 4;

export async function setupCapture(ctx, { env, options, saveSkill, permissionAction }) {
	const dir = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "auto-learn");
	const active = new Map();
	const requests = new Set();
	const generation = { session: { generate: (input) => {
		const request = ctx.session.generate(input);
		requests.add(request);
		request.then(() => requests.delete(request), () => requests.delete(request));
		return request;
	} } };
	const controller = new AbortController();
	let logging = Promise.resolve();
	const log = (record) => {
		logging = logging.then(() => appendLog(dir, record)).catch(() => {
			console.error("auto-learn: could not write the activity log.");
		});
		return logging;
	};
	const owns = (location) => location && path.resolve(location.directory) === path.resolve(ctx.location.directory) &&
		(location.workspaceID ?? null) === (ctx.location.workspaceID ?? null);

	await ctx.session.hook("prompt", ({ sessionID }) => { active.get(sessionID)?.controller.abort("new prompt"); });
	await ctx.session.hook("generate", async (event) => {
		const job = active.get(event.sessionID);
		const prompt = event.messages.at(-1);
		if (prompt?.role !== "user" || !prompt.content.some((part) => part.type === "text" && part.text === captureNudge("", "opencode"))) return;
		if (!job) throw new Error("The review no longer belongs to this OpenCode location.");
		job.controller.signal.throwIfAborted();
		const messages = await ctx.session.context({ sessionID: event.sessionID });
		if (messages.at(-1)?.id !== job.turnID) {
			job.controller.abort("the session has moved on");
			job.controller.signal.throwIfAborted();
		}
		event.tools = {};
		event.options.maxTokens = 8192;
	});
	await ctx.permission.hook("evaluate", (event) => {
		if (event.action === permissionAction && !event.source && active.has(event.sessionID) && event.effect === "ask") {
			event.effect = "deny";
			event.message = "Automatic skill reviews cannot request approval; allow the skill tool explicitly to enable saving.";
		}
	});

	const handle = async (event) => {
		const sessionID = event.data.sessionID;
		const key = `reviewed/${sessionID}`;
		if (event.type !== "session.execution.succeeded") {
			const job = active.get(sessionID);
			job?.controller.abort(event.type);
			if (event.type === "session.deleted") {
				await job?.work;
				await ctx.storage.remove(key);
			}
			return;
		}
		if (event.location && !owns(event.location)) return;
		if (active.has(sessionID)) return log({ event: "skip", session: sessionID, reason: "a review is already running" });
		if (await ctx.storage.get(key) === event.id) return;
		const session = await ctx.session.get({ sessionID });
		if (!owns(session.location)) return;
		const turn = selectTurn(await ctx.session.context({ sessionID }), event.id);
		const reason = session.parentID ? "subagent session" : session.agent === "plan" ? "plan mode" : turn.skip ||
			(turn.toolCalls < options.minToolCalls ? `fewer than ${options.minToolCalls} tool calls` : undefined) ||
			(active.size >= MAX_ACTIVE_REVIEWS || requests.size >= MAX_ACTIVE_REVIEWS ? "review concurrency limit reached" : undefined);
		if (reason) {
			await log({ event: "skip", session: sessionID, reason, ...(turn.toolCalls === undefined ? {} : { toolCalls: turn.toolCalls }) });
			await ctx.storage.set(key, event.id);
			return;
		}
		const job = { controller: new AbortController(), turnID: turn.turnID };
		active.set(sessionID, job);
		job.work = (async () => {
			await log({ event: "queued", session: sessionID, toolCalls: turn.toolCalls });
			const result = await reviewTurn(generation, { sessionID }, { saveSkill, signal: job.controller.signal });
			await log({ event: "capture", session: sessionID, ...result });
			await ctx.storage.set(key, event.id);
		})().catch(() => log({ event: "capture", session: sessionID, outcome: "error", error: "could not record the review result" }))
			.finally(() => active.delete(sessionID));
	};
	const events = (async () => {
		for await (const event of ctx.event.subscribe({
			types: ["session.execution.succeeded", "session.execution.started", "session.deleted", "session.moved"],
			signal: controller.signal,
		})) {
			try {
				await handle(event);
			} catch {
				await log({ event: "capture", session: event.data.sessionID, outcome: "error", error: "could not inspect the session" });
			}
		}
	})().catch(() => {
		if (!controller.signal.aborted) console.error("auto-learn: session event subscription stopped; reload the plugin to resume reviews.");
	});
	return async () => {
		controller.abort();
		for (const job of active.values()) job.controller.abort("plugin unloaded");
		await events;
		await Promise.allSettled([...active.values()].map((job) => job.work));
		await logging;
	};
}

export function selectTurn(messages, eventID) {
	const end = messages.at(-1);
	if (end?.type !== "idle" || end.id !== eventID.replace(/^evt_/, "msg_")) return { skip: "the session has moved on" };
	if (end.outcome !== "succeeded") return { skip: "the turn did not succeed" };
	let start = messages.length - 2;
	while (start >= 0 && messages[start].type !== "idle") start--;
	const turn = messages.slice(start + 1, -1);
	if (!turn.some((message) => message.type === "user")) return { skip: "no user prompt in the turn" };
	const replies = turn.filter((message) => message.type === "assistant");
	if (replies.some((message) => message.agent === "plan")) return { skip: "plan mode" };
	const toolCalls = replies.reduce((count, message) => count + message.content.filter((part) => part.type === "tool").length, 0);
	return { turnID: end.id, toolCalls };
}

export async function reviewTurn(ctx, job, { saveSkill, signal, timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
	const started = performance.now();
	const controller = new AbortController();
	const abort = () => controller.abort("cancelled");
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
	let error = "review request failed";
	let usage = {};
	try {
		controller.signal.throwIfAborted();
		const response = await abortable(ctx.session.generate({ sessionID: job.sessionID, prompt: captureNudge("", "opencode") }), controller.signal);
		usage = reviewUsage(response);
		error = "invalid review response";
		const proposal = parseProposal(response.text);
		const result = { outcome: "ok", created: [], updated: [], deleted: [] };
		if (proposal !== null) {
			controller.signal.throwIfAborted();
			error = "skill proposal refused";
			await abortable(saveSkill(proposal, { sessionID: job.sessionID }, controller.signal), controller.signal);
			result[proposal.action === "create" ? "created" : "updated"].push(proposal.name.trim().toLowerCase());
		}
		return { ...result, ...usage, durationMs: Math.round(performance.now() - started) };
	} catch {
		const outcome = controller.signal.aborted ? controller.signal.reason === "timeout" ? "timeout" : "aborted" : "error";
		return { outcome, ...(outcome === "error" ? { error } : {}), ...usage, durationMs: Math.round(performance.now() - started) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

function parseProposal(text) {
	if (typeof text !== "string" || Buffer.byteLength(text) > MAX_REVIEW_BYTES) throw new Error("Invalid response size.");
	const proposal = JSON.parse(text);
	if (proposal === null) return null;
	if (typeof proposal !== "object" || Array.isArray(proposal) ||
		(proposal.action !== "create" && proposal.action !== "update") ||
		["name", "description", "body"].some((key) => typeof proposal[key] !== "string") ||
		Object.keys(proposal).some((key) => !["action", "name", "description", "body"].includes(key))) {
		throw new Error("Invalid skill proposal.");
	}
	return proposal;
}

function reviewUsage(response) {
	const fields = {
		costUsd: response.cost,
		inputTokens: response.tokens?.input,
		outputTokens: response.tokens?.output,
		reasoningTokens: response.tokens?.reasoning,
		cacheReadTokens: response.tokens?.cache?.read,
		cacheWriteTokens: response.tokens?.cache?.write,
	};
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => Number.isFinite(value) && value >= 0));
}

// Native Promise calls may ignore cancellation; their late replies must never start a save.
function abortable(work, signal) {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
