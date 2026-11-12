// A minimal MCP server (JSON-RPC 2.0) that offers one tool, manage_skill.
import { PLUGIN_VERSION } from "./config.mjs";
import { manageSkillDescription } from "./prompts.mjs";
import { manageSkill } from "./skills.mjs";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INPUT_SCHEMA = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["create", "update", "delete"], description: "What to do with the skill." },
		name: {
			type: "string",
			description: 'The skill\'s name: 1-64 lowercase letters and digits, with single hyphens between words, such as "deploy-docs".',
		},
		description: {
			type: "string",
			description: "One line that says when to use the skill; Claude Code matches tasks against it. Needed for create and update.",
		},
		body: {
			type: "string",
			description: "The skill's instructions in Markdown, without frontmatter. Needed for create and update.",
		},
	},
	required: ["action", "name"],
	additionalProperties: false,
};

/**
 * Returns a handler that takes one parsed JSON-RPC message and resolves to
 * the reply, or to undefined for messages that need none.
 *
 * @param {{skillsDir: string, projectDir?: string}} context
 */
export function createMcpServer(context) {
	const tool = { name: "manage_skill", description: manageSkillDescription(context.skillsDir), inputSchema: INPUT_SCHEMA };
	return async function handle(message) {
		const isObject = message !== null && typeof message === "object" && !Array.isArray(message);
		if (!isObject) return failure(null, -32600, "Invalid Request");
		const { id = null, method, params } = message;
		if (typeof method !== "string") return "result" in message || "error" in message ? undefined : failure(id, -32600, "Invalid Request");
		if (message.jsonrpc !== "2.0") return failure(id, -32600, "Invalid Request");
		if (!("id" in message)) return undefined;
		switch (method) {
			case "initialize": {
				const requested = params?.protocolVersion;
				return success(id, {
					protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
					capabilities: { tools: {} },
					serverInfo: { name: "auto-learn", version: PLUGIN_VERSION },
				});
			}
			case "ping":
				return success(id, {});
			case "tools/list":
				return success(id, { tools: [tool] });
			case "tools/call": {
				if (params?.name !== tool.name) return failure(id, -32602, `Unknown tool: ${String(params?.name)}`);
				try {
					const text = await manageSkill(params.arguments ?? {}, context);
					return success(id, { content: [{ type: "text", text }] });
				} catch (error) {
					return success(id, { content: [{ type: "text", text: error.message }], isError: true });
				}
			}
			default:
				return failure(id, -32601, `Method not found: ${method}`);
		}
	};
}

function success(id, result) {
	return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}
