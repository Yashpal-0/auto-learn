import fs from "node:fs/promises";
import path from "node:path";
import { loadOptions, skillsDir } from "../scripts/lib/config.mjs";
import { inputSchema } from "../scripts/lib/mcp.mjs";
import { guidanceText, learnedSkillsText, manageSkillDescription } from "../scripts/lib/prompts.mjs";
import { learnedSkills, manageSkill, parseName } from "../scripts/lib/skills.mjs";
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
	let closed = false;
	const saveSkill = async (args, call, signal) => {
		signal?.throwIfAborted();
		const action = args?.action;
		if (action !== "create" && action !== "update" && action !== "delete") {
			throw new Error('action must be "create", "update" or "delete".');
		}
		const name = parseName(args?.name);
		const session = await ctx.session.get({ sessionID: call.sessionID });
		if (path.resolve(session.location.directory) !== path.resolve(ctx.location.directory) ||
			(session.location.workspaceID ?? null) !== (ctx.location.workspaceID ?? null)) {
			throw new Error("The session moved to another OpenCode location; retry the skill change there.");
		}
		// A person may leave this prompt unanswered for good, so it waits outside the queue of writes.
		await ctx.permission.assert({
			sessionID: call.sessionID,
			agent: call.agent ?? session.agent,
			action: TOOL_NAME,
			resources: [name],
			save: ["*"],
			...(call.id ? { source: { type: "tool", messageID: call.messageID, id: call.id } } : {}),
		});
		const write = writes.then(async () => {
			signal?.throwIfAborted();
			if (closed) throw new Error("auto-learn was unloaded, so the skill was not changed.");
			if (action === "create" && (await ctx.skill.list()).data.some((skill) => skill.id === name)) {
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

	const realPath = (target) => fs.realpath(target).catch(() => path.resolve(target));
	const injectGuidance = async (event) => {
		if (!Array.isArray(event.system)) return;
		let visible = [];
		try {
			const [{ data: catalog }, learned, realLibrary] = await Promise.all([
				ctx.skill.list(),
				learnedSkills(library),
				realPath(library),
			]);
			visible = (await Promise.all(learned.map(async (item) => {
				for (const skill of catalog) {
					if (skill.id !== item.name || skill.autoinvoke === false) continue;
					if (path.resolve(skill.path) === path.join(library, item.name, "SKILL.md") ||
						await realPath(skill.path) === path.join(realLibrary, item.name, "SKILL.md")) return item;
				}
				return null;
			}))).filter(Boolean);
		} catch {
			console.error("auto-learn: could not read the skill catalog for session guidance.");
		}
		event.system.push({ type: "text", text: [guidanceText(library, "opencode"), learnedSkillsText(visible, "opencode")].filter(Boolean).join("\n\n") });
	};
	for (const hook of ["context", "compaction", "generate"]) await ctx.session.hook(hook, injectGuidance);

	const stopCapture = options.autoCapture ? await setupCapture(ctx, { env, options, saveSkill, permissionAction: TOOL_NAME }) : async () => {};
	return async () => {
		closed = true;
		await stopCapture();
		await writes;
	};
}

export default { id: "auto-learn", setup: setupOpenCode };
