import path from "node:path";
import { loadOptions, skillsDir } from "../scripts/lib/config.mjs";
import { inputSchema } from "../scripts/lib/mcp.mjs";
import { guidanceText, learnedSkillsText, manageSkillDescription } from "../scripts/lib/prompts.mjs";
import { learnedSkills, manageSkill } from "../scripts/lib/skills.mjs";
import { setupCapture } from "./capture.mjs";

export const TOOL_NAME = "auto_learn_manage_skill";

export async function setupOpenCode(ctx, { env = process.env } = {}) {
	const options = { ...loadOptions({}), ...ctx.options };
	if (typeof options.autoCapture !== "boolean") throw new Error("auto-learn: autoCapture must be true or false.");
	if (!Number.isSafeInteger(options.minToolCalls) || options.minToolCalls < 0) {
		throw new Error("auto-learn: minToolCalls must be a non-negative whole number.");
	}
	const library = skillsDir(env, "opencode");
	let writes = Promise.resolve();
	const saveSkill = (args, call, signal) => {
		const write = writes.then(async () => {
			signal?.throwIfAborted();
			const session = await ctx.session.get({ sessionID: call.sessionID });
			if (path.resolve(session.location.directory) !== path.resolve(ctx.location.directory) ||
				(session.location.workspaceID ?? null) !== (ctx.location.workspaceID ?? null)) {
				throw new Error("The session moved to another OpenCode location; retry the skill change there.");
			}
			const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
			await ctx.permission.assert({
				sessionID: call.sessionID,
				agent: call.agent ?? session.agent,
				action: TOOL_NAME,
				resources: [name.slice(0, 64)],
				...(call.id ? { source: { type: "tool", messageID: call.messageID, id: call.id } } : {}),
			});
			if (args.action === "create" && (await ctx.skill.list()).data.some((skill) => skill.id === name)) {
				throw new Error(`A skill named "${name}" already exists in OpenCode. Update it if this plugin owns it, or pick another name.`);
			}
			signal?.throwIfAborted();
			const content = await manageSkill(args, { skillsDir: library, projectDir: session.location.directory, host: "opencode" });
			await ctx.skill.reload();
			return content;
		});
		// A failed write must reach its caller without blocking later saves.
		writes = write.catch(() => {});
		return write;
	};

	await ctx.tool.transform((editor) => {
		editor.namespace({ name: "auto_learn", description: "Save reusable procedures as personal OpenCode skills." });
		editor.add({
			name: "manage_skill",
			description: manageSkillDescription(library, "opencode"),
			input: inputSchema("OpenCode"),
			options: { namespace: "auto_learn", codemode: true },
			execute: async (args, call) => ({ content: await saveSkill(args, call, call.signal) }),
		});
	});

	await ctx.session.hook("context", async (event) => {
		const { data: catalog } = await ctx.skill.list();
		const visible = (await learnedSkills(library)).filter(({ name }) => catalog.some((skill) =>
			skill.id === name && skill.autoinvoke !== false && path.resolve(skill.path) === path.join(library, name, "SKILL.md"),
		));
		event.system.push({ type: "text", text: [guidanceText(library, "opencode"), learnedSkillsText(visible, "opencode")].filter(Boolean).join("\n\n") });
	});

	const stopCapture = options.autoCapture ? await setupCapture(ctx, { env, options, saveSkill, permissionAction: TOOL_NAME }) : async () => {};
	return async () => {
		await stopCapture();
		await writes;
	};
}

export default { id: "auto-learn", setup: setupOpenCode };
