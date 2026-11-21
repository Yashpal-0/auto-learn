// The texts the plugin gives to the model: the session guidance with the
// learned skills, the manage_skill description, and the request a capture fork
// receives. Each host gets its own wording.
import { readFileSync } from "node:fs";
import { displayPath } from "./config.mjs";

/** The most the learned-skill listing adds to a session's context, about 1,000 tokens. */
const MAX_LISTING_CHARS = 4000;
const PREVIEW_CHARS = 160;
const MIN_SENTENCE_CHARS = 40;

/** @param {"claude" | "codex" | "copilot" | "opencode" | "agy"} host */
function template(name, host) {
	const folder = host === "claude" ? "" : `${host}/`;
	return readFileSync(new URL(`../../prompts/${folder}${name}.md`, import.meta.url), "utf8");
}

/** Replaces each {{key}} in `text` with its value, in one pass, so values are never expanded again. */
export function fill(text, values) {
	return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
		if (!Object.hasOwn(values, key)) throw new Error(`The prompt needs a value for {{${key}}}.`);
		return String(values[key]);
	});
}

/** Standing guidance for every session, added at session start. */
export function guidanceText(skillsDir, host = "claude") {
	return fill(template("guidance", host), { skillsDir: displayPath(skillsDir) }).trim();
}

/**
 * The learned skills, each with a short description, or "" when there are
 * none. `skills` come newest first; the ones past the size limit are counted
 * instead of listed.
 *
 * @param {Array<{name: string, description: string}>} skills
 */
export function learnedSkillsText(skills, host = "claude") {
	if (skills.length === 0) return "";
	return fill(template("learned-skills", host), { skills: learnedSkillLines(skills) }).trim();
}

/** The lines of the learned-skill listing, one skill each, or "" without skills; see learnedSkillsText. */
export function learnedSkillLines(skills) {
	const lines = [];
	let size = 0;
	for (const { name, description } of skills) {
		const line = description ? `- ${name}: ${preview(description)}` : `- ${name}`;
		size += line.length + 1;
		if (size > MAX_LISTING_CHARS + 1) break;
		lines.push(line);
	}
	const omitted = skills.length - lines.length;
	if (omitted > 0) lines.push(`- ${omitted} older learned ${omitted === 1 ? "skill is" : "skills are"} not listed here.`);
	return lines.join("\n");
}

/** The description whole when it is short, else its first sentence, else cut at a word. */
function preview(description) {
	if (description.length <= PREVIEW_CHARS) return description;
	const sentence = /^.+?[.!?](?=\s)/.exec(description)?.[0] ?? "";
	if (sentence.length >= MIN_SENTENCE_CHARS && sentence.length <= PREVIEW_CHARS) return sentence;
	const cut = description.slice(0, PREVIEW_CHARS - 1);
	const wordEnd = cut.lastIndexOf(" ");
	return `${wordEnd > 0 ? cut.slice(0, wordEnd) : cut}…`;
}

export function manageSkillDescription(skillsDir, host = "claude") {
	return fill(template("manage-skill", host), { skillsDir: displayPath(skillsDir) }).trim();
}

/** The prompt a capture fork gets after the turn it reviews. */
export function captureNudge(toolName, host = "claude") {
	return fill(template("capture", host), { tool: toolName }).trim();
}
