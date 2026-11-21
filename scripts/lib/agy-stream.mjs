// Reads what an agy review prints with `--output-format stream-json` (the event
// shapes were checked with agy 1.5.14): the review's manage_skill saves, its
// tokens and how it ended, and the first call of any tool the review has no
// business with. `init.tools` lists the whole tool registry whatever the agent
// allows, so this watch is the check that the agent's limits held. Keeps names
// and counts, never text.
import { noteToolName, requestedSave } from "./capture.mjs";
import { clip } from "./transcript.mjs";

const MAX_ERROR_CHARS = 500;
const MAX_REASON_CHARS = 100;
const MAX_TOOL_NAME_CHARS = 256;
/** What agy gives every agent whatever its tool list says: its own task list and the plugin's MCP resources. */
const TOLERATED_TOOLS = new Set(["list_resources", "read_resource", "manage_task"]);

/**
 * agy names a plugin's MCP server `<plugin folder>_<server key>` and calls its
 * tools through `call_mcp_tool`. The key is `auto-learn`; the folder is the
 * plugin's name unless the user installed it under another.
 */
const isOwnServer = (name) => typeof name === "string" && (name === "auto-learn" || name.endsWith("_auto-learn"));

const isObject = (value) => value !== null && typeof value === "object";
const asText = (value) => (typeof value === "string" ? value : "?");
const finite = (value) => (Number.isFinite(value) ? value : 0);

/** What the review's tool call is, from the first event of its step: its own manage_skill call, an ordinary tool of every agent, or one to stop the review for. */
function judge(step) {
	const tool = step.tool_name;
	const parameters = step.tool_info?.parameters;
	if (tool === "call_mcp_tool") {
		if (isOwnServer(parameters?.ServerName) && parameters.ToolName === "manage_skill") return { own: true, save: requestedSave(parameters.Arguments), settled: false };
		return { foreign: `call_mcp_tool:${asText(parameters?.ServerName)}/${asText(parameters?.ToolName)}` };
	}
	if (TOLERATED_TOOLS.has(tool)) return { own: false, tolerated: tool };
	return { foreign: typeof tool === "string" ? tool : "unknown tool" };
}

/**
 * @typedef {object} StreamSummary
 * @property {string} [conversationId] the review's conversation, as agy names it; check it before it names a path
 * @property {string} [status] "SUCCESS" or "ERROR" from the result event; none when the run printed no result
 * @property {string} [finishedReason]
 * @property {string} [error]
 * @property {number} deniedActions actions agy refused for want of permission
 * @property {number} skillCalls the review's manage_skill calls
 * @property {Array<{action: "create" | "update" | "delete", name: string}>} saves its calls that changed a skill, in order
 * @property {number} otherToolCalls calls of the tools agy gives every agent
 * @property {string[]} otherTools their names
 * @property {string} [stoppedTool] the tool that stopped the review
 * @property {number} inputTokens all tokens the model read, those from its cache included (agy's input_tokens leaves them out)
 * @property {number} cacheReadTokens
 * @property {number} outputTokens the tokens of its replies, which agy counts with the model's reasoning
 */

/**
 * An analyzer for one review's stream. `accept` takes the parsed events in
 * order and says `{stop}` at the first call of a tool that is not the
 * review's, after which it ignores everything; `finish` summarizes the run so
 * far, also for one that was stopped or killed before its result.
 */
export function createStreamAnalyzer() {
	const calls = new Map();
	const replies = new Map();
	const otherTools = new Set();
	const saves = [];
	let skillCalls = 0;
	let otherToolCalls = 0;
	let deniedActions = 0;
	let conversationId;
	let result = {};
	let stoppedTool;

	function acceptTool(step) {
		const index = step.step_index;
		let call = Number.isSafeInteger(index) ? calls.get(index) : undefined;
		if (call === undefined) {
			call = judge(step);
			if (call.foreign !== undefined) {
				stoppedTool = clip(call.foreign, MAX_TOOL_NAME_CHARS);
				return { stop: stoppedTool };
			}
			if (Number.isSafeInteger(index)) calls.set(index, call);
			if (call.own) skillCalls++;
			else {
				otherToolCalls++;
				noteToolName(otherTools, call.tolerated);
			}
		}
		// A permission denied under strict mode leaves the call "DONE" without output, and a failed one has an error.
		if (call.own && !call.settled && (step.state === "DONE" || step.state === "ERROR")) {
			call.settled = true;
			const info = step.tool_info;
			if (step.state === "DONE" && call.save !== undefined && typeof info?.output === "string" && info.output !== "" && !info.error) saves.push(call.save);
		}
		return undefined;
	}

	function acceptStep(step) {
		if (!isObject(step)) return undefined;
		if (conversationId === undefined && typeof step.conversation_id === "string") conversationId = step.conversation_id;
		if (step.step_type === "agent_response" && step.state === "DONE" && isObject(step.usage) && Number.isSafeInteger(step.step_index)) replies.set(step.step_index, step.usage);
		return step.step_type === "tool" ? acceptTool(step) : undefined;
	}

	function acceptResult(printed) {
		if (conversationId === undefined && typeof printed.conversation_id === "string") conversationId = printed.conversation_id;
		deniedActions = Array.isArray(printed.denied_actions) ? printed.denied_actions.length : 0;
		result = {
			status: typeof printed.status === "string" ? clip(printed.status, MAX_REASON_CHARS) : undefined,
			finishedReason: typeof printed.finished_reason === "string" ? clip(printed.finished_reason, MAX_REASON_CHARS) : undefined,
			error: typeof printed.error === "string" ? clip(printed.error, MAX_ERROR_CHARS) : undefined,
		};
	}

	return {
		accept(event) {
			if (stoppedTool !== undefined || !isObject(event)) return undefined;
			if (event.event === "init") {
				if (typeof event.conversation_id === "string") conversationId = event.conversation_id;
			} else if (event.event === "step_update") {
				return acceptStep(event.step_update);
			} else if (event.event === "result" && isObject(event.result)) {
				acceptResult(event.result);
			}
			return undefined;
		},

		/** @returns {StreamSummary} */
		finish() {
			const sum = (key) => [...replies.values()].reduce((total, usage) => total + finite(usage[key]), 0);
			const summary = {
				conversationId,
				...result,
				deniedActions,
				skillCalls,
				saves: [...saves],
				otherToolCalls,
				otherTools: [...otherTools],
				stoppedTool,
				inputTokens: sum("input_tokens") + sum("cache_read_tokens"),
				cacheReadTokens: sum("cache_read_tokens"),
				outputTokens: sum("output_tokens"),
			};
			return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
		},
	};
}
