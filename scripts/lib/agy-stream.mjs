// Reads what an agy review prints with `--output-format stream-json` (the event
// shapes were checked with agy 1.5.14): the review's manage_skill saves, its
// tokens and how it ended, and the first call of any tool the review has no
// business with. `init.tools` lists the whole tool registry whatever the agent
// allows, so this watch is the check that the agent's limits held. Keeps names
// and counts, never text.
import { noteToolName, requestedSave } from "./capture.mjs";
import { parseName, savedMessageStart } from "./skills.mjs";
import { clip } from "./transcript.mjs";

const MAX_ERROR_CHARS = 500;
const MAX_REASON_CHARS = 100;
const MAX_TOOL_NAME_CHARS = 256;
/** What agy gives every agent whatever its tool list says: its own task list and the plugin's MCP resources. */
const TOLERATED_TOOLS = new Set(["list_resources", "read_resource", "manage_task"]);

/**
 * agy names a plugin's MCP server `<plugin folder>_<server key>`. The key is
 * `auto-learn`; the folder is the plugin's name unless the user installed it
 * under another.
 */
const isOwnServer = (name) => typeof name === "string" && (name === "auto-learn" || name.endsWith("_auto-learn"));

/**
 * agy reports an eager tool, as the plugin's mcp_config.json makes manage_skill,
 * as a tool of its own named `mcp_<server>_<tool>`, and a lazy one as a
 * `call_mcp_tool` call. The name does not say where the server's name ends, so
 * every server whose name passes `isOwnServer` counts, in both spellings.
 */
const EAGER_SKILL_TOOL = /^mcp_(.+)_manage_skill$/;

const isObject = (value) => value !== null && typeof value === "object";
/** A tool or server name as the log may keep it: its characters only, never the free text a model could put there. */
const asName = (value) => (typeof value === "string" ? value.replace(/[^\w.:/@-]/g, "?") : "?");
const finite = (value) => (Number.isFinite(value) ? value : 0);

/**
 * Whether `output` holds, at the start of one of its lines (agy puts its own
 * "Created At" lines before the tool's text), the message manageSkill returns
 * for this save. A refusal comes back through the same field and says
 * otherwise, and how agy reports an MCP error is not recorded.
 */
function confirmsSave({ action, name }, output) {
	let start;
	try {
		start = savedMessageStart(action, parseName(name));
	} catch {
		// An invalid name was refused, whatever the output says.
		return false;
	}
	return output.split("\n").some((line) => line.startsWith(start));
}

/** What the review's tool call is, from the first event of its step: its own manage_skill call, an ordinary tool of every agent, or one to stop the review for. */
function judge(step) {
	const tool = step.tool_name;
	const parameters = step.tool_info?.parameters;
	if (tool === "call_mcp_tool") {
		if (isOwnServer(parameters?.ServerName) && parameters.ToolName === "manage_skill") return { own: true, save: requestedSave(parameters.Arguments), settled: false };
		return { foreign: `call_mcp_tool:${asName(parameters?.ServerName)}/${asName(parameters?.ToolName)}` };
	}
	const eager = typeof tool === "string" ? EAGER_SKILL_TOOL.exec(tool) : null;
	if (eager !== null && isOwnServer(eager[1])) return { own: true, save: requestedSave(parameters), settled: false };
	if (TOLERATED_TOOLS.has(tool)) return { own: false, tolerated: tool };
	return { foreign: typeof tool === "string" ? asName(tool) : "unknown tool" };
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
 * order and says `{stop: reason}` at the init event of a run under another
 * agent than `agent`, or at the first call of a tool that is not the review's,
 * after which it ignores everything; `finish` summarizes the run so far, also
 * for one that was stopped or killed before its result.
 *
 * @param {string} agent the agent the review must run under
 */
export function createStreamAnalyzer(agent) {
	const calls = new Map();
	const replies = new Map();
	const otherTools = new Set();
	const saves = [];
	let skillCalls = 0;
	let otherToolCalls = 0;
	let deniedActions = 0;
	let conversationId;
	let result = {};
	let stopped = false;
	let stoppedTool;

	function acceptTool(step) {
		const index = step.step_index;
		let call = Number.isSafeInteger(index) ? calls.get(index) : undefined;
		if (call === undefined) {
			call = judge(step);
			if (call.foreign !== undefined) {
				stoppedTool = clip(call.foreign, MAX_TOOL_NAME_CHARS);
				stopped = true;
				return { stop: "the review called a tool other than manage_skill" };
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
			if (step.state === "DONE" && call.save !== undefined && typeof info?.output === "string" && !info.error && confirmsSave(call.save, info.output)) saves.push(call.save);
		}
		return undefined;
	}

	function acceptStep(step) {
		if (!isObject(step)) return undefined;
		if (conversationId === undefined && typeof step.conversation_id === "string") conversationId = step.conversation_id;
		if (step.step_type === "agent_response" && step.state === "DONE" && isObject(step.usage) && Number.isSafeInteger(step.step_index)) replies.set(step.step_index, step.usage);
		// Any step that carries a tool is judged, whatever type agy files it under: a tool the watch missed would be one it never stopped.
		return step.step_type === "tool" || typeof step.tool_name === "string" || isObject(step.tool_info) ? acceptTool(step) : undefined;
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
			if (stopped || !isObject(event)) return undefined;
			if (event.event === "init") {
				if (typeof event.conversation_id === "string") conversationId = event.conversation_id;
				const running = event.init?.agent;
				if (running !== agent) {
					stopped = true;
					return { stop: `agy ran the review under the agent ${JSON.stringify(clip(asName(running), MAX_REASON_CHARS))}, not ${JSON.stringify(agent)}` };
				}
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
