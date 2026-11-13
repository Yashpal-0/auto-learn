// Reads Claude Code session transcripts (JSONL, one entry per line): the
// tool calls of a turn, and the entry to fork the session at once the turn
// has ended.
import { followLines, parseLine, readLines } from "./jsonl.mjs";

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
export async function findForkPoint(file, { start, end, signal, timeoutMs = FORK_POINT_TIMEOUT_MS, pollDelay }) {
	const chain = new Map();
	const remember = (line) => {
		const entry = chainEntry(line);
		if (entry) chain.set(entry.uuid, entry);
		return entry;
	};
	await readLines(file, start, end, remember);
	const outcome = await followLines(
		file,
		end,
		(line) => {
			const entry = remember(line);
			if (!entry || entry.isSidechain) return undefined;
			if (entry.type === "system" && entry.subtype === "stop_hook_summary") return walkBack(chain, entry.parentUuid);
			if (entry.isPrompt) return { skip: "a new prompt arrived before the turn ended" };
			return undefined;
		},
		{ signal, timeoutMs, pollDelay },
	);
	if (outcome) return outcome;
	if (signal?.aborted) return { skip: "aborted" };
	return { skip: `the turn did not end within ${Math.round(timeoutMs / 1000)} s` };
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
