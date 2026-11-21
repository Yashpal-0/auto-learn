// Reads the transcript of an Antigravity CLI conversation, transcript_full.jsonl
// in the conversation's brain folder: finds the turn that just ended and
// writes it out as text for the review. A line is a step, `{step_index,
// source, type, status, content?, error?, thinking?, tool_calls?}` (checked
// with agy 1.5.14). A prompt a person typed is USER_INPUT from USER_EXPLICIT,
// the model's replies and tool calls are PLANNER_RESPONSE, and a tool's result
// is the GENERIC step after the call.
import fs from "node:fs/promises";
import { parseLine, readLines } from "./jsonl.mjs";
import { clip } from "./transcript.mjs";

/** The most each kind of text adds to the review's excerpt, in characters, and the most the whole excerpt holds. */
export const EXCERPT_LIMITS = { user: 4000, reply: 2000, args: 600, result: 1200, total: 60_000 };

/** Room for the line that says how many steps were left out. */
const MARKER_RESERVE = 80;

const isPrompt = (record) => record?.type === "USER_INPUT" && record.source === "USER_EXPLICIT";

/**
 * Finds the turn that ends the transcript: the last prompt a person typed and
 * the tool calls the model made after it. The scan starts at `fromOffset`, the
 * start of the turn found at the previous stop, so a long session costs one
 * turn of reading per stop; an offset from which no prompt follows, as after
 * agy rewrote the file, is dropped for a scan from the start. `end` is where
 * the last complete line ends, so a line agy is still writing is left for the
 * next stop.
 *
 * @returns {Promise<{offset: number, promptId: string, toolCalls: number, end: number} | undefined>}
 */
export async function scanTurn(file, fromOffset = 0) {
	const size = (await fs.stat(file)).size;
	if (fromOffset > 0 && fromOffset < size) {
		const turn = await scan(file, fromOffset, size);
		if (turn) return turn;
	}
	return scan(file, 0, size);
}

async function scan(file, start, size) {
	let turn;
	const end = await readLines(file, start, size, (line, lineStart) => {
		const record = parseLine(line);
		if (isPrompt(record)) turn = { offset: lineStart, promptId: String(record.step_index ?? lineStart), toolCalls: 0 };
		else if (turn && record?.type === "PLANNER_RESPONSE" && Array.isArray(record.tool_calls)) turn.toolCalls += record.tool_calls.length;
	});
	return turn && { ...turn, end };
}

/**
 * The steps that start in [start, end) of the transcript, written out as text:
 * the request, the model's replies, each tool call with its arguments, each
 * result. The model's reasoning and agy's system messages are left out. Each
 * kind of text is cut to its limit. A turn over the total keeps its first step
 * and its newest ones, with a line that counts the steps left out between.
 */
export async function renderTurn(file, start, end, limits = EXCERPT_LIMITS) {
	const steps = [];
	await readLines(file, start, end, (line) => {
		const blocks = renderStep(parseLine(line), limits);
		if (blocks.length > 0) steps.push(blocks.join("\n\n"));
	});
	return fit(steps, limits.total);
}

function renderStep(record, limits) {
	const blocks = [];
	const text = (label, value, limit) => {
		if (typeof value === "string" && value.trim() !== "") blocks.push(`[${label}]\n${clip(value.trim(), limit)}`);
	};
	if (isPrompt(record)) {
		text("user", requestText(record.content), limits.user);
	} else if (record?.type === "PLANNER_RESPONSE") {
		text("assistant", record.content, limits.reply);
		for (const call of Array.isArray(record.tool_calls) ? record.tool_calls : []) {
			blocks.push(`[tool call] ${String(call?.name)}\n${clip(JSON.stringify(call?.args ?? {}), limits.args)}`);
		}
	} else if (record?.type === "GENERIC") {
		text("tool result", record.content, limits.result);
		text("tool error", record.error, limits.result);
	} else if (record?.type === "ERROR_MESSAGE") {
		text("error", record.content ?? record.error, limits.result);
	}
	return blocks;
}

/** What a person typed: agy wraps it in a request tag and adds metadata after it. */
function requestText(content) {
	if (typeof content !== "string") return undefined;
	return /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)?.[1] ?? content;
}

function fit(steps, total) {
	const whole = steps.join("\n\n");
	if (whole.length <= total) return whole;
	const [first, ...rest] = steps;
	let budget = total - first.length - MARKER_RESERVE;
	let kept = 0;
	while (kept < rest.length && rest[rest.length - 1 - kept].length + 2 <= budget) {
		budget -= rest[rest.length - 1 - kept].length + 2;
		kept++;
	}
	const omitted = rest.length - kept;
	return [first, `[… ${omitted} earlier ${omitted === 1 ? "step" : "steps"} left out …]`, ...rest.slice(omitted)].join("\n\n");
}
