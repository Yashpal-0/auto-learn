// The managed skill store. It creates, updates and deletes skills in the
// personal skill library and never changes a skill it did not create.
import fs from "node:fs/promises";
import path from "node:path";
import { displayPath } from "./config.mjs";
import { writeFileAtomic } from "./files.mjs";

/** The file that marks a skill directory as created, and so owned, by this plugin. */
export const MARKER_FILE = ".auto-learn";
const MARKER_TEXT =
	"This skill was created by the auto-learn plugin, which may update or delete it.\n" +
	"Delete this file to take ownership; auto-learn will then leave the skill alone.\n";

/** The largest SKILL.md this plugin writes, frontmatter included. */
export const MAX_SKILL_BYTES = 32_768;
/** The longest description this plugin writes. Claude Code lists every description in each session. */
export const MAX_DESCRIPTION_CHARS = 1024;

const MAX_NAME_CHARS = 64;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MISSING = new Set(["ENOENT", "ENOTDIR"]);

const SECRET_PATTERNS = [
	["a private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
	["an API key", /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/],
	["a GitHub token", /\b(?:gh[opsur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
	["a GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
	["a Slack token", /\bxox[abeprs]-[A-Za-z0-9-]{10,}/],
	["an AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
	["a Google API key", /\bAIza[A-Za-z0-9_-]{35}/],
	["a JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/**
 * Runs one manage_skill call and returns a message for the model. A refused
 * call throws an Error whose message says what to change.
 *
 * @param {{action?: unknown, name?: unknown, description?: unknown, body?: unknown}} args
 * @param {{skillsDir: string, projectDir?: string, host?: "claude" | "codex" | "opencode"}} context
 */
export async function manageSkill(args, context) {
	const { action, name: rawName, description, body } = args ?? {};
	if (action !== "create" && action !== "update" && action !== "delete") {
		throw new Error('action must be "create", "update" or "delete".');
	}
	const name = parseName(rawName);
	if (action === "delete") return deleteSkill(name, context);
	const content = renderSkill(name, action, description, body);
	return action === "create" ? createSkill(name, content, context) : updateSkill(name, content, context);
}

function parseName(raw) {
	const text = String(raw ?? "");
	const name = text.trim().toLowerCase();
	if (name.length > MAX_NAME_CHARS || !NAME_PATTERN.test(name)) {
		throw new Error(
			`${JSON.stringify(text)} is not a valid skill name: use 1-${MAX_NAME_CHARS} lowercase letters and digits, ` +
				'with single hyphens between words (for example "deploy-docs").',
		);
	}
	return name;
}

function renderSkill(name, action, rawDescription, rawBody) {
	if (typeof rawDescription !== "string" || typeof rawBody !== "string") {
		throw new Error(`"${action}" needs both description and body.`);
	}
	const description = cleanDescription(rawDescription);
	if (!description) {
		throw new Error("description must not be empty (control characters, angle brackets and backticks are removed).");
	}
	if (description.length > MAX_DESCRIPTION_CHARS) {
		throw new Error(
			`description is ${description.length} characters, over the ${MAX_DESCRIPTION_CHARS} character limit. ` +
				"Say in one line when to use the skill.",
		);
	}
	const body = rawBody.replace(/^\s*\n/, "").trimEnd();
	if (!body) throw new Error("body must not be empty.");
	if (/^---[ \t]*\r?\n/.test(body)) {
		throw new Error("body must not start with a frontmatter block (---): the tool writes it from name and description.");
	}
	const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_SKILL_BYTES) {
		throw new Error(`The skill would be ${bytes} bytes, over the ${MAX_SKILL_BYTES} byte limit. Shorten the body.`);
	}
	for (const [label, pattern] of SECRET_PATTERNS) {
		if (pattern.test(content)) throw new Error(`The skill seems to contain ${label}. Remove it: skills must never hold secrets.`);
	}
	return content;
}

/**
 * Makes a description safe to list in a prompt: one line, without control or
 * format characters, and without the angle brackets, backticks and tildes that
 * could open a tag or a code fence.
 */
export function cleanDescription(value) {
	return String(value ?? "")
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~+/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

async function createSkill(name, content, context) {
	const projectSkills = await projectSkillsDir(context);
	// A personal skill would shadow the project's skill of the same name.
	if (projectSkills && (await entryType(path.join(projectSkills, name)))) {
		throw new Error(`A skill named "${name}" already exists in this project. Pick another name.`);
	}
	await fs.mkdir(context.skillsDir, { recursive: true });
	const dir = path.join(context.skillsDir, name);
	try {
		await fs.mkdir(dir);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		throw new Error(
			(await isManagedSkillDir(dir))
				? `A skill named "${name}" already exists and this tool created it. Use action "update" to change it.`
				: `A skill named "${name}" already exists and the user owns it. Pick another name.`,
		);
	}
	const file = path.join(dir, "SKILL.md");
	try {
		await fs.writeFile(path.join(dir, MARKER_FILE), MARKER_TEXT, { flag: "wx" });
		await writeFileAtomic(file, content);
	} catch (error) {
		await fs.rm(dir, { recursive: true, force: true });
		throw error;
	}
	return `Created skill "${name}" at ${displayPath(file)}.`;
}

async function updateSkill(name, content, context) {
	const dir = await managedSkillDir(name, context, "update");
	const file = path.join(dir, "SKILL.md");
	const stats = await lstatIfPresent(file);
	// A link means the user tied this file to another place; replacing it would silently cut that tie.
	if (stats?.isSymbolicLink()) throw new Error(`The SKILL.md of "${name}" is a symbolic link, so this tool will not replace it.`);
	if (stats && !stats.isFile()) throw new Error(`The SKILL.md of "${name}" is not a regular file, so this tool will not replace it.`);
	if (stats && stats.nlink > 1) throw new Error(`The SKILL.md of "${name}" has other hard links, so this tool will not replace it.`);
	await writeFileAtomic(file, content);
	return `Updated skill "${name}" at ${displayPath(file)}.`;
}

async function deleteSkill(name, context) {
	const dir = await managedSkillDir(name, context, "delete");
	await fs.rm(dir, { recursive: true });
	return `Deleted skill "${name}".`;
}

/** The directory of a skill this tool created, or an Error that says why it may not be changed. */
async function managedSkillDir(name, { skillsDir }, action) {
	const dir = path.join(skillsDir, name);
	const type = await entryType(dir);
	if (type === undefined) {
		throw new Error(
			action === "update" ? `There is no skill named "${name}". Use action "create" to add it.` : `There is no skill named "${name}".`,
		);
	}
	if (type === "symlink") throw new Error(`The skill "${name}" is a symbolic link, so this tool will not change it.`);
	if (!(await isManagedSkillDir(dir))) throw new Error(`The skill "${name}" was not created by this tool, so it will not change it.`);
	return dir;
}

async function isManagedSkillDir(dir) {
	const [dirType, markerType] = await Promise.all([entryType(dir), entryType(path.join(dir, MARKER_FILE))]);
	return dirType === "directory" && markerType === "file";
}

/** The project's skills directory, or undefined when there is none or it is the personal library itself. */
// shortcut: for Codex, checks the project's own .agents/skills only, while Codex also reads those of the folders up to the repository root; walk them when a learned skill shadows one there.
async function projectSkillsDir({ skillsDir, projectDir, host }) {
	if (!projectDir) return undefined;
	const folder = host === "opencode" ? ".opencode" : host === "codex" ? ".agents" : ".claude";
	const dir = path.join(projectDir, folder, "skills");
	const [project, personal] = await Promise.all([canonicalPath(dir), canonicalPath(skillsDir)]);
	return project === personal ? undefined : dir;
}

async function canonicalPath(target) {
	try {
		return await fs.realpath(target);
	} catch (error) {
		if (MISSING.has(error.code)) return path.resolve(target);
		throw error;
	}
}

async function lstatIfPresent(target, options) {
	try {
		return await fs.lstat(target, options);
	} catch (error) {
		if (MISSING.has(error.code)) return undefined;
		throw error;
	}
}

async function entryType(target) {
	const stats = await lstatIfPresent(target);
	if (!stats) return undefined;
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isDirectory()) return "directory";
	return stats.isFile() ? "file" : "other";
}

/** A version stamp for each managed skill, to tell which skills a capture created, updated or deleted. */
export async function managedSkillVersions(skillsDir) {
	const versions = new Map();
	for (const name of await skillDirNames(skillsDir)) {
		const dir = path.join(skillsDir, name);
		if (!(await isManagedSkillDir(dir))) continue;
		const stats = await lstatIfPresent(path.join(dir, "SKILL.md"), { bigint: true });
		if (stats) versions.set(name, `${stats.ino}:${stats.mtimeNs}:${stats.size}`);
	}
	return versions;
}

/**
 * The skills auto-learn created, most recently changed first, each with the
 * description from its SKILL.md made safe to list, or "" when it has none.
 *
 * @returns {Promise<Array<{name: string, description: string}>>}
 */
export async function learnedSkills(skillsDir) {
	const skills = [];
	for (const name of await skillDirNames(skillsDir)) {
		const dir = path.join(skillsDir, name);
		if (!(await isManagedSkillDir(dir))) continue;
		const skill = await readSkillHead(path.join(dir, "SKILL.md"));
		if (skill) skills.push({ name, description: frontmatterDescription(skill.head), changedMs: skill.changedMs });
	}
	return skills.sort((a, b) => b.changedMs - a.changedMs).map(({ name, description }) => ({ name, description }));
}

/** The first MAX_SKILL_BYTES of a SKILL.md and when it last changed, or undefined when it is missing. The user may have edited it to any size. */
async function readSkillHead(file) {
	let handle;
	try {
		handle = await fs.open(file, "r");
	} catch (error) {
		if (MISSING.has(error.code)) return undefined;
		throw error;
	}
	try {
		const buffer = Buffer.alloc(MAX_SKILL_BYTES);
		const [{ bytesRead }, stats] = await Promise.all([handle.read(buffer, 0, MAX_SKILL_BYTES, 0), handle.stat()]);
		return { head: buffer.toString("utf8", 0, bytesRead), changedMs: stats.mtimeMs };
	} finally {
		await handle.close();
	}
}

// shortcut: reads a one-line description, as manage_skill writes it; a multi-line YAML value gives "". Parse YAML if hand-edited skills need it.
function frontmatterDescription(text) {
	const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? "";
	const value = /^description:[ \t]*(.*)$/m.exec(frontmatter)?.[1].trim() ?? "";
	if (/^[|>]/.test(value)) return "";
	return cleanDescription(value.startsWith('"') ? parseQuoted(value) : value);
}

function parseQuoted(value) {
	try {
		return String(JSON.parse(value));
	} catch {
		// A YAML escape or comment that JSON lacks: list the text as written.
		return value;
	}
}

async function skillDirNames(dir) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (MISSING.has(error.code)) return [];
		throw error;
	}
	return entries
		.filter((entry) => !entry.name.startsWith(".") && entry.isDirectory())
		.map((entry) => entry.name)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
