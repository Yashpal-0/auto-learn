// The managed skill store. It creates, updates and deletes skills in the
// personal skill library and never changes a skill it did not create.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
const CLAUDE_RESERVED_NAMES = new Set(["synced", "anthropic-skills"]);
/** Hosts whose manage_skill supports revision-checked reads, updates, deletes and per-skill locks. */
const REVISIONED_HOSTS = new Set(["claude", "agy"]);
/** The placeholders Claude Code fills in when it loads a skill; with no arguments given they become nothing. */
const ARGUMENT_PLACEHOLDER = /\$ARGUMENTS(?:\[\d+\])?|\$\d+/g;
// Rests on a static reading of Claude Code 2.1.332, not a live run.
// shortcut: a plain relative @path still attaches its file; refuse every @ mention if a skill must never pull project files in.
const OUTSIDE_MENTION = /(?<=^|\s)@(?:["'\/~]|[A-Za-z]:[\\/]|(?:\S*[\/\\])?\.\.(?=[\/\\]|\s|$))/m;
const MISSING = new Set(["ENOENT", "ENOTDIR"]);
const runFile = promisify(execFile);

const SAVED_VERBS = { create: "Created", update: "Updated", delete: "Deleted" };

/**
 * The words that start the message manageSkill returns once `action` has
 * changed the skill `name`, which is the name as saved. A reader of that message
 * can tell a save from an error that came back in the same place.
 */
export const savedMessageStart = (action, name) => `${SAVED_VERBS[action]} skill "${name}"`;

const SECRET_PATTERNS = [
	["a private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
	["an API key", /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/],
	["a GitHub token", /\b(?:gh[opsur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
	["a GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
	["a Slack token", /\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}/],
	["an AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
	["a Google API key", /\bAIza[A-Za-z0-9_-]{35}/],
	["a JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
	["a Stripe key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
	["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
	["a Hugging Face token", /\bhf_[A-Za-z0-9]{30,}/],
	["a PyPI token", /\bpypi-AgE[A-Za-z0-9_-]{30,}/],
	// The user may be empty, as in Redis URLs, or hold an @; a password that starts with $, < or { is a placeholder; the scheme's bound keeps text like a.a.a. linear to scan.
	["a password in a URL", /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s\/:<>]*:(?![$<{])[^\s\/@<>]{3,}@/i],
	["a bearer token", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/],
	// Lowercase bearer is also prose ("bearer token-based-auth"), so this rule needs a digit, as the sk- rule does.
	["a bearer token", /\bbearer\s+(?=[A-Za-z0-9._~+\/-]*\d)[A-Za-z0-9._~+\/-]{20,}/i],
	["an AWS secret access key", /aws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9\/+]{40}/i],
	["a Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
	["a Google OAuth access token", /\bya29\.[A-Za-z0-9_-]{20,}/],
	["an age secret key", /AGE-SECRET-KEY-1[A-Z0-9]{50,}/],
	["a Slack webhook URL", /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/],
	["an OAuth token secret", /oauth_token_secret["']?\s*[=:]\s*["']?[A-Za-z0-9]{20,}/],
	["an OAuth token secret", /access_secret["']?\s*[=:]\s*["']?[A-Za-z0-9]{40,}/],
	// A PLAINTEXT signature is the consumer secret, &, then the token secret; Launchpad's consumer secret is empty.
	["an OAuth token secret", /oauth_signature="?(?:&|%26)[A-Za-z0-9]{40,}/],
];

/**
 * Runs one manage_skill call and returns a message for the model. A refused
 * call throws an Error whose message says what to change.
 *
 * @param {{action?: unknown, name?: unknown, description?: unknown, body?: unknown, revision?: unknown}} args
 * @param {{skillsDir: string, projectDir?: string, agentsSkillsDir?: string, otherSkillsDirs?: string[], builtinSkillsDirs?: string[], host?: "claude" | "codex" | "copilot" | "opencode" | "agy"}} context
 * `agentsSkillsDir` is the personal folder `create` also checks for a taken name, which GitHub Copilot and Antigravity CLI read next to their own.
 * `otherSkillsDirs` are other personal folders the host reads with higher priority, which `create` also checks.
 * `builtinSkillsDirs` are the folders of the skills that ship with the agent, which `create` also checks, since a personal skill of the same name replaces one.
 */
export async function manageSkill(args, context) {
	const { action, name: rawName, description, body, revision } = args ?? {};
	const host = context.host ?? "claude";
	const isClaude = host === "claude";
	const revisioned = REVISIONED_HOSTS.has(host);
	if (action !== "create" && action !== "update" && action !== "delete" && !(revisioned && action === "read")) {
		throw new Error(revisioned ? 'action must be "read", "create", "update" or "delete".' : 'action must be "create", "update" or "delete".');
	}
	const name = parseName(rawName);
	if (isClaude && action === "create" && CLAUDE_RESERVED_NAMES.has(name)) {
		throw new Error(`The skill name "${name}" is reserved by Claude Code. Pick another name.`);
	}
	if (action === "read") {
		const dir = await managedSkillDir(name, context, "read");
		return JSON.stringify(await readRevision(name, path.join(dir, "SKILL.md")));
	}
	const content = action === "delete" ? undefined : renderSkill(name, action, description, body);
	const change = () => action === "delete" ? deleteSkill(name, context, revision) :
		action === "create" ? createSkill(name, content, context) : updateSkill(name, content, context, revision);
	return revisioned ? withSkillLock(name, context, change) : change();
}

async function withSkillLock(name, { skillsDir, host }, change) {
	await fs.mkdir(skillsDir, { recursive: true });
	const file = path.join(skillsDir, `.auto-learn.${name}.lock`);
	let handle;
	try {
		handle = await fs.open(file, "wx", 0o600);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const agent = host === "agy" ? "Antigravity" : "Claude";
		throw new Error(`Another process is changing skill "${name}". Retry after it finishes. If ${displayPath(file)} remains after ${agent} exits, remove that lock file.`);
	}
	try {
		await handle.writeFile(`${process.pid}\n`);
		return await change();
	} finally {
		try {
			await handle.close();
		} finally {
			await fs.rm(file, { force: true });
		}
	}
}

async function readRevision(name, file) {
	const stats = await lstatIfPresent(file);
	if (!stats) return { revision: "missing", content: null };
	if (stats.isSymbolicLink()) throw new Error(`The SKILL.md of "${name}" is a symbolic link, so this tool will not read it.`);
	if (!stats.isFile()) throw new Error(`The SKILL.md of "${name}" is not a regular file, so this tool will not read it.`);
	const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
			if (bytesRead === 0) break;
			size += bytesRead;
		}
		if (size > MAX_SKILL_BYTES) throw new Error(`The SKILL.md of "${name}" is over the ${MAX_SKILL_BYTES} byte limit. Shorten it before reading or changing it.`);
		const bytes = buffer.subarray(0, size);
		return { revision: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("utf8") };
	} finally {
		await handle.close();
	}
}

async function checkRevision(name, file, revision, context) {
	if (!REVISIONED_HOSTS.has(context.host ?? "claude")) return;
	if (typeof revision !== "string" || !/^(?:[a-f0-9]{64}|missing)$/.test(revision)) {
		throw new Error('Use action "read" first and pass its revision when updating or deleting a skill.');
	}
	if ((await readRevision(name, file)).revision !== revision) {
		throw new Error(`Skill "${name}" changed since it was read. Read it again and preserve its current steps before retrying.`);
	}
}

/** The name `raw` gives a skill, as the store saves it. Throws when it is not a valid skill name. */
export function parseName(raw) {
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
	// Claude Code fills in arguments before it runs these, so an unclosed !` or ```!, or a ! beside $ARGUMENTS, could still become a command.
	const filled = [body, body.replace(ARGUMENT_PLACEHOLDER, "")];
	if (filled.some((text) => /(?<=^|\s)!(?=`|\$)/m.test(text) || text.includes("```!"))) {
		throw new Error(
			"body must not contain !`command`, ```! blocks or a ! next to an argument placeholder such as $ARGUMENTS: Claude Code runs them as shell commands when the skill loads, after it fills in the arguments, so a placeholder before the ! counts too. " +
				"Show commands in an ordinary ```sh block, without the leading !.",
		);
	}
	if (filled.some((text) => OUTSIDE_MENTION.test(text))) {
		throw new Error(
			"body must not @-mention a file outside the project (an absolute, ~, quoted or .. path): Claude Code attaches that file to the conversation when the skill loads. " +
				"Write the path without the leading @.",
		);
	}
	const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_SKILL_BYTES) {
		throw new Error(`The skill would be ${bytes} bytes, over the ${MAX_SKILL_BYTES} byte limit. Shorten the body.`);
	}
	// The cleaned strings, not the file: its JSON-escaped description hides a double-quoted secret from the patterns.
	const scanned = `${name}\n${description}\n${body}`;
	for (const [label, pattern] of SECRET_PATTERNS) {
		if (pattern.test(scanned)) throw new Error(`The skill seems to contain ${label}. Remove it: skills must never hold secrets.`);
	}
	return content;
}

/**
 * Makes a description safe to list in a prompt: one line, without control or
 * format characters, and without the angle brackets, backticks and tildes that
 * could open a tag or a code fence, or three hyphens in a row, which Claude
 * Code takes for the end of the frontmatter wherever they stand.
 */
export function cleanDescription(value) {
	return String(value ?? "")
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~+/g, "~")
		.replace(/-{3,}/g, "--")
		.replace(/\s+/g, " ")
		.trim();
}

async function createSkill(name, content, context) {
	const projectSkills = await projectSkillsDir(context);
	// A personal skill would shadow the project's skill of the same name.
	const host = context.host ?? "claude";
	const personal = await canonicalPath(context.skillsDir);
	const folders = [];
	for (const folder of [projectSkills, context.agentsSkillsDir, ...(context.otherSkillsDirs ?? []), ...(context.builtinSkillsDirs ?? [])]) {
		if (folder && (await canonicalPath(folder)) !== personal) folders.push(folder);
	}
	const conflict = host === "claude" ? await claudeSkillConflict(name, context) :
		(await existingSkill(name, folders)) ?? (host === "agy" ? await declaredSkill(name, folders) : undefined);
	if (conflict) {
		throw new Error(`A skill named "${name}" already exists at ${displayPath(conflict)}. Pick another name.`);
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
	return `${savedMessageStart("create", name)} at ${displayPath(file)}.`;
}

/** The path of the first skill called `name` in `folders`, skipping the missing ones, or undefined. */
async function existingSkill(name, folders) {
	for (const folder of folders) {
		if (folder && (await entryType(path.join(folder, name)))) return path.join(folder, name);
	}
	return undefined;
}

/**
 * The path of the first skill in `folders` whose SKILL.md declares `name`.
 * agy lists a skill by that name, which can differ from its folder's:
 * antigravity_guide holds "antigravity-guide". A personal skill of the same
 * name would replace it.
 */
async function declaredSkill(name, folders) {
	for (const folder of folders) {
		if (!folder) continue;
		for (const entry of await skillDirNames(folder)) {
			const skill = await readSkillHead(path.join(folder, entry, "SKILL.md"));
			if (skill && frontmatterField(skill.head, "name").toLowerCase() === name) return path.join(folder, entry);
		}
	}
	return undefined;
}

/** Refuses a SKILL.md that is a link or not a plain file: the user may have tied it to another place, and `verb` (what this tool would do) would silently cut that tie. */
async function checkSkillFile(name, file, verb) {
	const stats = await lstatIfPresent(file);
	if (stats?.isSymbolicLink()) throw new Error(`The SKILL.md of "${name}" is a symbolic link, so this tool will not ${verb} it.`);
	if (stats && !stats.isFile()) throw new Error(`The SKILL.md of "${name}" is not a regular file, so this tool will not ${verb} it.`);
	if (stats && stats.nlink > 1) throw new Error(`The SKILL.md of "${name}" has other hard links, so this tool will not ${verb} it.`);
}

async function updateSkill(name, content, context, revision) {
	const dir = await managedSkillDir(name, context, "update");
	const file = path.join(dir, "SKILL.md");
	await checkSkillFile(name, file, "replace");
	await checkRevision(name, file, revision, context);
	await writeFileAtomic(file, content);
	return `${savedMessageStart("update", name)} at ${displayPath(file)}.`;
}

async function deleteSkill(name, context, revision) {
	const dir = await managedSkillDir(name, context, "delete");
	const file = path.join(dir, "SKILL.md");
	await checkSkillFile(name, file, "delete");
	await checkRevision(name, file, revision, context);
	// The folder is the user's too once they add a file to it; the recursive rm below would destroy that file.
	const extra = (await fs.readdir(dir)).filter((entry) => entry !== "SKILL.md" && entry !== MARKER_FILE).sort();
	if (extra.length > 0) {
		const listed = extra.slice(0, 5).map((entry) => JSON.stringify(entry)).join(", ") + (extra.length > 5 ? `, and ${extra.length - 5} more` : "");
		throw new Error(`The skill "${name}" holds files this tool did not write (${listed}), so it will not delete the folder. Delete ${displayPath(dir)} yourself if you want it gone.`);
	}
	await fs.rm(dir, { recursive: true });
	return `${savedMessageStart("delete", name)}.`;
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

async function claudeSkillConflict(name, { skillsDir, projectDir }) {
	const personal = await canonicalPath(skillsDir);
	const candidates = [path.join(path.dirname(path.resolve(skillsDir)), "commands", `${name}.md`)];
	if (projectDir) {
		const projects = await claudeProjectDirs(projectDir);
		for (const project of projects) {
			const skills = path.join(project, ".claude", "skills");
			if ((await canonicalPath(skills)) !== personal) candidates.push(path.join(skills, name));
			candidates.push(path.join(project, ".claude", "commands", `${name}.md`));
		}
		for (const folder of await claudeWorktreeFolders(projects.at(-1))) {
			if (path.basename(folder) === "commands") candidates.push(path.join(folder, `${name}.md`));
			else if ((await canonicalPath(folder)) !== personal) candidates.push(path.join(folder, name));
		}
	}
	for (const candidate of candidates) if (await entryType(candidate)) return candidate;
	return undefined;
}

async function claudeProjectDirs(projectDir) {
	const directories = [];
	for (let dir = await canonicalPath(projectDir); ; dir = path.dirname(dir)) {
		directories.push(dir);
		if (await entryType(path.join(dir, ".git"))) return directories;
		if (path.dirname(dir) === dir) return directories.slice(0, 1);
	}
}

async function claudeWorktreeFolders(root) {
	if ((await entryType(path.join(root, ".git"))) !== "file") return [];
	const missing = [];
	for (const folder of ["skills", "commands"]) {
		try {
			if ((await fs.stat(path.join(root, ".claude", folder))).isDirectory()) continue;
		} catch (error) {
			if (!MISSING.has(error.code)) throw error;
		}
		missing.push(folder);
	}
	if (missing.length === 0) return [];
	const [gitDir, commonDir] = await Promise.all([gitPath(root, "--git-dir"), gitPath(root, "--git-common-dir")]);
	if (gitDir === commonDir) return [];
	const main = path.dirname(commonDir);
	if (path.basename(commonDir) !== ".git" || (await canonicalPath(await gitPath(main, "--show-toplevel"))) !== main) {
		throw new Error("Cannot check inherited skills in this worktree's main checkout. Ensure the worktree has its own .claude/skills and .claude/commands directories before creating a personal skill.");
	}
	return missing.map((folder) => path.join(main, ".claude", folder));
}

async function gitPath(directory, flag) {
	try {
		const { stdout } = await runFile("git", ["-C", directory, "rev-parse", "--path-format=absolute", flag], {
			env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
			timeout: 5000,
			maxBuffer: 64 * 1024,
			encoding: "utf8",
		});
		const result = stdout.replace(/\n$/, "");
		if (path.isAbsolute(result)) return result;
	} catch (error) {
		throw new Error("Cannot check inherited skills for this checkout. Ensure Git 2.31 or later is on PATH and the worktree is valid, then retry.", { cause: error });
	}
	throw new Error("Git returned no absolute checkout path; repair the worktree before creating a personal skill.");
}

/** The project's skills directory, or undefined when there is none or it is the personal library itself. */
// shortcut: for Codex, checks the project's own .agents/skills only, while Codex also reads those of the folders up to the repository root; walk them when a learned skill shadows one there.
// shortcut: for GitHub Copilot, checks the project's .github/skills (of the session's working folder) and ~/.agents/skills, while Copilot also reads the project's .agents/skills and .claude/skills and the .github/skills of the folders up to the repository root; check those too when a learned skill shadows one there.
// shortcut: for agy, checks the project's own .agents/skills, ~/.agents/skills, ~/.gemini/antigravity-cli/skills, ~/.gemini/skills and the builtin skills, while agy also reads the project's .agent, _agents and _agent folders, those of the folders up to the git root, and the skills that workspace and global skills.json and plugins.json files declare; check those too when a learned skill shadows one there.
async function projectSkillsDir({ skillsDir, projectDir, host }) {
	if (!projectDir) return undefined;
	const folder = { opencode: ".opencode", codex: ".agents", copilot: ".github", agy: ".agents" }[host] ?? ".claude";
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

async function lstatIfPresent(target) {
	try {
		return await fs.lstat(target);
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
		try {
			if (!(await isManagedSkillDir(dir))) continue;
			const skill = await readSkillHead(path.join(dir, "SKILL.md"));
			if (skill) skills.push({ name, description: frontmatterDescription(skill.head), changedMs: skill.changedMs });
		} catch {
			// shortcut: a skill that cannot be read (permissions, a folder where SKILL.md should be) is left out of the list unreported; log it if users need to know why.
		}
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

// shortcut: reads a one-line value, as manage_skill writes it; a multi-line YAML value gives "". Parse YAML if hand-edited skills need it.
function frontmatterField(text, key) {
	const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1] ?? "";
	const value = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(frontmatter)?.[1].trim() ?? "";
	if (/^[|>]/.test(value)) return "";
	return value.startsWith('"') ? parseQuoted(value) : value;
}

function frontmatterDescription(text) {
	return cleanDescription(frontmatterField(text, "description"));
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
