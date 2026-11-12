// The texts the plugin gives to Claude: the session guidance, the
// manage_skill description, and the request a capture fork receives.
import { readFileSync } from "node:fs";
import { displayPath } from "./config.mjs";

function template(name) {
	return readFileSync(new URL(`../../prompts/${name}.md`, import.meta.url), "utf8");
}

/** Replaces each {{key}} in `text` with its value, in one pass, so values are never expanded again. */
export function fill(text, values) {
	return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
		if (!Object.hasOwn(values, key)) throw new Error(`The prompt needs a value for {{${key}}}.`);
		return String(values[key]);
	});
}

/** Standing guidance for every session, added at session start. */
export function guidanceText(skillsDir) {
	return fill(template("guidance"), { skillsDir: displayPath(skillsDir) }).trim();
}

export function manageSkillDescription(skillsDir) {
	return fill(template("manage-skill"), { skillsDir: displayPath(skillsDir) }).trim();
}

/** The prompt a capture fork gets after the turn it reviews. */
export function captureNudge(toolName) {
	return fill(template("capture"), { tool: toolName }).trim();
}
