// Reads Codex session rollouts (JSONL, one record per line): where the session
// was started from, the tool calls and settings of a turn, and when the turn
// ended. The record shapes were verified with Codex 0.168.
import { followLines, parseLine, readLines } from "./jsonl.mjs";

const TURN_END_TIMEOUT_MS = 10 * 60 * 1000;
/** More than the session_meta line can need: Codex 0.168 writes about 22 KB, most of it the base instructions. */
const MAX_SESSION_META_BYTES = 1024 * 1024;
/** The finished items that are tool calls, as item_completed events name them. */
const TOOL_ITEMS = new Set([
	"CommandExecution",
	"FileChange",
	"McpToolCall",
	"DynamicToolCall",
	"CollabAgentToolCall",
	"SubAgentActivity",
	"WebSearch",
	"ImageView",
	"ImageGeneration",
]);

/**
 * What the rollout's first line says about the session: where it was started
 * from (`source`, such as "cli" for the terminal or "exec" for codex exec) and
 * its model provider. Undefined when the first line is not a session_meta
 * record or the rollout is gone.
 *
 * @returns {Promise<{source?: string, modelProvider?: string} | undefined>}
 */
export async function readSessionMeta(file) {
	let first;
	let isFirstLine = true;
	try {
		await readLines(file, 0, MAX_SESSION_META_BYTES, (line) => {
			if (isFirstLine) first = parseLine(line);
			isFirstLine = false;
		});
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	if (first?.type !== "session_meta") return undefined;
	const { source, model_provider: modelProvider } = first.payload ?? {};
	return {
		...(typeof source === "string" ? { source } : {}),
		...(typeof modelProvider === "string" && modelProvider ? { modelProvider } : {}),
	};
}

/**
 * The tool calls and settings of turn `turnId`, read from the lines that
 * start in [start, end), and `next`, the offset just past the last complete
 * line read. When the turn began before `start`, as a turn that a Stop hook
 * continued did, the rollout is read again from its beginning.
 *
 * @returns {Promise<{toolCalls: number, settings: {model?: string, effort?: string, mode?: string}, next: number}>}
 */
export async function readRolloutTurn(file, start, end, turnId) {
	let turn = await scanTurn(file, start, end, turnId);
	if (!turn.isStartSeen && start > 0) turn = await scanTurn(file, 0, end, turnId);
	const { toolCalls, settings, next } = turn;
	return { toolCalls, settings, next };
}

async function scanTurn(file, start, end, turnId) {
	const toolItems = new Set();
	let context;
	let isStartSeen = false;
	const next = await readLines(file, start, end, (line) => {
		const record = parseLine(line);
		const payload = record?.payload;
		if (payload?.turn_id !== turnId) return;
		if (record.type === "turn_context") {
			// A turn that compaction interrupts records its context again; the latest one holds.
			context = payload;
			isStartSeen = true;
		} else if (record.type === "event_msg" && payload.type === "task_started") {
			isStartSeen = true;
		} else if (record.type === "event_msg" && payload.type === "item_completed" && TOOL_ITEMS.has(payload.item?.type)) {
			toolItems.add(payload.item.id ?? `#${toolItems.size}`);
		}
	});
	return { toolCalls: toolItems.size, settings: turnSettings(context), isStartSeen, next };
}

/** The model, reasoning effort and collaboration mode ("default" or "plan") the turn ran with. */
function turnSettings(context) {
	const { model, effort } = context ?? {};
	const mode = context?.collaboration_mode?.mode;
	return {
		...(typeof model === "string" && model ? { model } : {}),
		...(typeof effort === "string" && effort ? { effort } : {}),
		...(typeof mode === "string" ? { mode } : {}),
	};
}

/**
 * Waits for turn `turnId`, whose Stop hook saw the rollout end at byte `end`,
 * to finish. Codex records the turn's end once its Stop hooks have run: a
 * task_complete event, or turn_aborted when the user interrupted it. When the
 * turn did not end, or the wait timed out or was aborted, the result is
 * `{skip}` with the reason.
 *
 * @returns {Promise<{ended: true} | {skip: string}>}
 */
export async function findTurnEnd(file, { end, turnId, signal, timeoutMs = TURN_END_TIMEOUT_MS, pollDelay }) {
	const outcome = await followLines(
		file,
		end,
		(line) => {
			const record = parseLine(line);
			if (record?.type !== "event_msg") return undefined;
			const { type, turn_id: id } = record.payload ?? {};
			if (type === "task_complete" && id === turnId) return { ended: true };
			if (type === "turn_aborted" && id === turnId) return { skip: "the turn was interrupted" };
			if (type === "task_started" && id !== turnId) return { skip: "a new turn started before the turn ended" };
			return undefined;
		},
		{ signal, timeoutMs, pollDelay },
	);
	if (outcome) return outcome;
	if (signal?.aborted) return { skip: "aborted" };
	return { skip: `the turn did not end within ${Math.round(timeoutMs / 1000)} s` };
}
