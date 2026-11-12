// Reads Claude Code session transcripts (JSONL, one entry per line): the
// tool calls of a turn, and the entry to fork the session at once the turn
// has ended.
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;
const FORK_POINT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_WALK_STEPS = 1000;

/**
 * The user and assistant entries of the main conversation that start in the
 * byte range [start, end), and `next`, the offset just past the last complete
 * line read. A line still being written is left for the next read.
 */
export async function readTranscriptRange(file, start, end) {
	const entries = [];
	const next = await readLines(file, start, end, (line) => {
		const value = parseLine(line);
		if ((value?.type === "user" || value?.type === "assistant") && !value.isSidechain) entries.push({ type: value.type, message: value.message });
	});
	return { entries, next };
}

/** Calls `visit` with each complete line that starts in [start, end), and returns the offset just past the last one. */
async function readLines(file, start, end, visit) {
	let next = start;
	if (end <= start) return next;
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.alloc(CHUNK_BYTES);
		let pending = [];
		let pendingBytes = 0;
		let isSkippingLine = false;
		for (let position = start; position < end; ) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, end - position), position);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			let from = 0;
			for (let newline = chunk.indexOf(NEWLINE); newline !== -1; newline = chunk.indexOf(NEWLINE, from)) {
				if (!isSkippingLine) {
					const piece = chunk.subarray(from, newline);
					visit(pendingBytes ? Buffer.concat([...pending, piece]) : piece);
				}
				pending = [];
				pendingBytes = 0;
				isSkippingLine = false;
				from = newline + 1;
				next = position + from;
			}
			const rest = chunk.subarray(from);
			if (!isSkippingLine && rest.length > 0) {
				if (pendingBytes + rest.length > MAX_LINE_BYTES) {
					isSkippingLine = true;
					pending = [];
					pendingBytes = 0;
				} else {
					pending.push(Buffer.from(rest));
					pendingBytes += rest.length;
				}
			}
			position += bytesRead;
		}
	} finally {
		await handle.close();
	}
	return next;
}

function parseLine(line) {
	try {
		return JSON.parse(line.toString("utf8"));
	} catch {
		// A torn line, such as one a range starts in the middle of, carries nothing to read.
		return undefined;
	}
}

function contentBlocks(entry) {
	const content = entry.message?.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.filter((block) => block && typeof block === "object") : [];
}

/** The number of distinct tool calls the assistant made. */
export function countToolCalls(entries) {
	const ids = new Set();
	for (const entry of entries) {
		if (entry.type !== "assistant") continue;
		for (const block of contentBlocks(entry)) {
			if (block.type === "tool_use") ids.add(block.id ?? `#${ids.size}`);
		}
	}
	return ids.size;
}

/**
 * Waits for the turn whose Stop hook saw the transcript end at byte `end` to
 * finish, and returns the chain entry to fork the session at: the turn's last
 * entry, with the model of its last reply. Claude Code writes the turn's last
 * entries after its Stop hooks run, then a stop_hook_summary entry whose
 * parent is the turn's last entry. When the turn did not end there, or the
 * wait timed out or was aborted, the result is `{skip}` with the reason.
 *
 * @param {string} file The transcript.
 * @param {object} options
 * @param {number} options.start Where the turn's entries begin in the transcript.
 * @param {number} options.end The transcript's size when the Stop hook ran.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{uuid: string, model?: string} | {skip: string}>}
 */
export async function findForkPoint(file, { start, end, signal, timeoutMs = FORK_POINT_TIMEOUT_MS, pollDelay = defaultPollDelay }) {
	const chain = new Map();
	const remember = (line) => {
		const entry = chainEntry(line);
		if (entry) chain.set(entry.uuid, entry);
		return entry;
	};
	await readLines(file, start, end, remember);
	const started = performance.now();
	for (let position = end; ; ) {
		let outcome;
		position = await readLines(file, position, (await fs.stat(file)).size, (line) => {
			const entry = remember(line);
			if (outcome || !entry || entry.isSidechain) return;
			if (entry.type === "system" && entry.subtype === "stop_hook_summary") outcome = walkBack(chain, entry.parentUuid);
			else if (entry.isPrompt) outcome = { skip: "a new prompt arrived before the turn ended" };
		});
		if (outcome) return outcome;
		if (signal?.aborted) return { skip: "aborted" };
		const elapsed = performance.now() - started;
		if (elapsed >= timeoutMs) return { skip: `the turn did not end within ${Math.round(timeoutMs / 1000)} s` };
		try {
			await sleep(Math.min(pollDelay(elapsed), timeoutMs - elapsed), undefined, { signal });
		} catch (error) {
			if (error.name !== "AbortError") throw error;
		}
	}
}

/** Poll often at first, since the turn's end usually lands within a second, then back off while slow Stop hooks run. */
function defaultPollDelay(elapsedMs) {
	return elapsedMs < 10_000 ? 250 : 1000;
}

function chainEntry(line) {
	const value = parseLine(line);
	if (typeof value?.uuid !== "string") return undefined;
	const isAssistant = value.type === "assistant";
	return {
		uuid: value.uuid,
		parentUuid: value.parentUuid,
		type: value.type,
		subtype: value.subtype,
		isSidechain: value.isSidechain === true,
		isMeta: value.isMeta === true,
		isPrompt: value.type === "user" && value.isMeta !== true && !contentBlocks(value).some((block) => block.type === "tool_result"),
		attachment: value.type === "attachment" ? value.attachment : undefined,
		model: isAssistant ? (value.requestedModel ?? value.message?.model) : undefined,
		isSynthetic: isAssistant && value.message?.model === "<synthetic>",
	};
}

/**
 * Follows the chain back from the turn's last entry to its last reply, and
 * tells from the entries in between whether the turn really ended there.
 */
function walkBack(chain, lastUuid) {
	let uuid = lastUuid;
	for (let step = 0; step < MAX_WALK_STEPS; step++) {
		const entry = chain.get(uuid);
		if (!entry) return { skip: "the turn's last entry is not in the transcript" };
		switch (entry.type) {
			case "assistant":
				if (entry.isSynthetic) return { skip: "the turn ended without a reply from the model" };
				return { uuid: lastUuid, ...(typeof entry.model === "string" ? { model: entry.model } : {}) };
			case "user":
				return { skip: entry.isMeta ? "a Stop hook continued the turn" : "the turn did not end with a reply from the model" };
			case "attachment": {
				const attachment = entry.attachment ?? {};
				// Forking after a met or failed goal also keeps the fork from restoring the goal and chasing it again.
				if (attachment.type === "goal_status" && !attachment.met && !attachment.failed) return { skip: "the goal is not met yet, so the turn goes on" };
				if (attachment.type === "hook_additional_context" && attachment.hookEvent === "Stop") return { skip: "a Stop hook continued the turn" };
				break;
			}
			default:
				break;
		}
		uuid = entry.parentUuid;
	}
	return { skip: "the turn's last reply was not found" };
}

/** `text` cut to at most `max` UTF-16 units plus a note of how much was cut, never splitting a surrogate pair. */
export function clip(text, max) {
	if (text.length <= max) return text;
	let cut = max;
	const code = text.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut--;
	return `${text.slice(0, cut)}… [${text.length - cut} more characters]`;
}
