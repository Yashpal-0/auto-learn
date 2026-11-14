// A minimal MCP server (JSON-RPC 2.0) that offers one tool, manage_skill.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "./config.mjs";
import { manageSkillDescription } from "./prompts.mjs";
import { manageSkill } from "./skills.mjs";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** The capability that makes Codex send each tool call the session's sandbox, its working directory included. */
const SANDBOX_STATE = "codex/sandbox-state";

/** @param {string} agent The agent that offers saved skills. */
export function inputSchema(agent) {
	return {
		type: "object",
		properties: {
			action: { type: "string", enum: ["create", "update", "delete"], description: "What to do with the skill." },
			name: {
				type: "string",
				description: 'The skill\'s name: 1-64 lowercase letters and digits, with single hyphens between words, such as "deploy-docs".',
			},
			description: {
				type: "string",
				description: `One line that says when to use the skill; ${agent} matches tasks against it. Needed for create and update.`,
			},
			body: {
				type: "string",
				description: "The skill's instructions in Markdown, without frontmatter. Needed for create and update.",
			},
		},
		required: ["action", "name"],
		additionalProperties: false,
	};
}

/**
 * Returns a handler that takes one parsed JSON-RPC message and resolves to
 * the reply, or to undefined for messages that need none. For Codex, which
 * starts the server in the plugin's folder, each call's project is the
 * working directory in the sandbox state the call carries, not `projectDir`.
 *
 * @param {{skillsDir: string, projectDir?: string, host?: "claude" | "codex"}} context
 */
export function createMcpServer(context) {
	const isCodex = context.host === "codex";
	const tool = {
		name: "manage_skill",
		description: manageSkillDescription(context.skillsDir, context.host),
		inputSchema: inputSchema(isCodex ? "Codex" : "Claude Code"),
	};
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
					capabilities: isCodex ? { tools: {}, experimental: { [SANDBOX_STATE]: {} } } : { tools: {} },
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
					const text = await manageSkill(params.arguments ?? {}, isCodex ? { ...context, projectDir: sandboxCwd(params) } : context);
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

/** The working directory in the sandbox state Codex sends with a call, or undefined without a usable one. */
function sandboxCwd(params) {
	const cwd = params?._meta?.[SANDBOX_STATE]?.sandboxCwd;
	if (typeof cwd !== "string") return undefined;
	let dir;
	try {
		dir = cwd.startsWith("file:") ? fileURLToPath(cwd) : cwd;
	} catch {
		// A file URL with a remote host names no local directory.
		return undefined;
	}
	return path.isAbsolute(dir) ? dir : undefined;
}

function success(id, result) {
	return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}
