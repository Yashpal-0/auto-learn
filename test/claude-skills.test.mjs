import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MAX_SKILL_BYTES, manageSkill } from "../scripts/lib/skills.mjs";
import { tempDir } from "./helpers.mjs";

async function linkedWorktree(t, { mainName = "main checkout", separateGitDir = false } = {}) {
	const root = await tempDir(t);
	const main = path.join(root, mainName);
	const worktree = path.join(root, "linked checkout");
	const git = (args) => execFileSync("git", ["-c", `core.hooksPath=${path.join(root, "no hooks")}`, ...args], {
		env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
		timeout: 10_000,
		stdio: "pipe",
	});
	git(["init", "--quiet", "--initial-branch=main", ...(separateGitDir ? ["--separate-git-dir", path.join(root, "repository data")] : []), main]);
	git(["-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Fixture"]);
	git(["-C", main, "worktree", "add", "--quiet", "--detach", worktree]);
	return { root, main, worktree };
}

async function library(t) {
	const root = await tempDir(t);
	const context = { skillsDir: path.join(root, ".claude", "skills"), host: "claude" };
	await manageSkill({ action: "create", name: "build-app", description: "Use when building the app", body: "1. Build." }, context);
	const read = async () => JSON.parse(await manageSkill({ action: "read", name: "build-app" }, context));
	const update = (body, revision) => manageSkill({ action: "update", name: "build-app", description: "Use when building the app", body, revision }, context);
	return { root, context, read, update, file: path.join(context.skillsDir, "build-app", "SKILL.md") };
}

test("Claude updates and deletes require a revision instead of overwriting unseen changes", async (t) => {
	const { context, update, file } = await library(t);
	await assert.rejects(update("Unseen replacement."), /read.*revision/i);
	await assert.rejects(manageSkill({ action: "delete", name: "build-app" }, context), /read.*revision/i);
	assert.match(await fs.readFile(file, "utf8"), /1\. Build\./);
});

test("read returns a managed skill's complete text and a revision for update and delete", async (t) => {
	const { context, read, update, file } = await library(t);
	const before = await read();
	assert.equal(before.content, '---\nname: build-app\ndescription: "Use when building the app"\n---\n\n1. Build.\n');
	assert.match(before.revision, /^[a-f0-9]{64}$/);
	assert.match(await update("1. Build.\n2. Test.", before.revision), /^Updated skill/);
	const after = await read();
	assert.notEqual(after.revision, before.revision);
	assert.match(await manageSkill({ action: "delete", name: "build-app", revision: after.revision }, context), /^Deleted skill/);
	await assert.rejects(fs.access(file), { code: "ENOENT" });
});

test("a stale revision cannot overwrite or delete a newer save", async (t) => {
	const { context, read, update, file } = await library(t);
	const { revision } = await read();
	await update("1. Build.\n2. Keep session A's calibration.", revision);
	await assert.rejects(update("1. Build.\n2. Session B's old copy.", revision), /changed.*read/i);
	await assert.rejects(manageSkill({ action: "delete", name: "build-app", revision }, context), /changed.*read/i);
	assert.match(await fs.readFile(file, "utf8"), /session A's calibration/);
});

test("a revision also detects a user's edit made after reading a skill", async (t) => {
	const { read, update, file } = await library(t);
	const { revision } = await read();
	await fs.appendFile(file, "User's required step.\n");
	await assert.rejects(update("Old steps.", revision), /changed.*read/i);
	assert.match(await fs.readFile(file, "utf8"), /User's required step/);
});

test("competing saves with one revision admit only one writer", async (t) => {
	const { read, update } = await library(t);
	const { revision } = await read();
	const saved = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => update(`Writer ${i}.`, revision)));
	assert.equal(saved.filter(({ status }) => status === "fulfilled").length, 1);
	for (const result of saved.filter(({ status }) => status === "rejected")) assert.match(result.reason.message, /changed|changing/);
	const current = await read();
	assert.match(current.content, /Writer \d+\./);
	assert.match(await update("Final steps.", current.revision), /^Updated skill/);
});

test("read is bounded and never follows a skill file's symbolic link", async (t) => {
	const { root, read, file } = await library(t);
	await fs.writeFile(file, "x".repeat(MAX_SKILL_BYTES + 1));
	await assert.rejects(read(), /byte limit|too large/);
	const target = path.join(root, "outside.md");
	await fs.writeFile(target, "Outside content.");
	await fs.rm(file);
	await fs.symlink(target, file);
	await assert.rejects(read(), /symbolic link/);
	assert.equal(await fs.readFile(target, "utf8"), "Outside content.");
});

test("a managed skill with a missing file can be read and restored with its revision", async (t) => {
	const { read, update, file } = await library(t);
	await fs.rm(file);
	const missing = await read();
	assert.deepEqual(missing, { revision: "missing", content: null });
	await update("Restored steps.", missing.revision);
	assert.match(await fs.readFile(file, "utf8"), /Restored steps/);
});

test("read refuses skills the user owns", async (t) => {
	const { context, read } = await library(t);
	await fs.rm(path.join(context.skillsDir, "build-app", ".auto-learn"));
	await assert.rejects(read(), /not created by this tool/);
});

test("Claude creation rejects inherited project skills and legacy commands", async (t) => {
	const root = await tempDir(t);
	const repo = path.join(root, "repo");
	const projectDir = path.join(repo, "packages", "app");
	const context = { skillsDir: path.join(root, "home", ".claude", "skills"), projectDir, host: "claude" };
	await fs.mkdir(path.join(repo, ".git"), { recursive: true });
	await fs.mkdir(projectDir, { recursive: true });
	const fixtures = [
		["inherited-build", path.join(repo, ".claude", "skills", "inherited-build", "SKILL.md")],
		["ancestor-command", path.join(repo, ".claude", "commands", "ancestor-command.md")],
		["project-command", path.join(projectDir, ".claude", "commands", "project-command.md")],
		["personal-command", path.join(root, "home", ".claude", "commands", "personal-command.md")],
	];
	for (const [name, file] of fixtures) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "User's original procedure.\n");
		await assert.rejects(manageSkill({ action: "create", name, description: "Build", body: "New steps." }, context), /already exists/);
		assert.equal(await fs.readFile(file, "utf8"), "User's original procedure.\n");
		await assert.rejects(fs.access(path.join(context.skillsDir, name)), { code: "ENOENT" });
	}
});

test("Claude collision checks stop at a worktree root's .git file", async (t) => {
	const { root, worktree: repo } = await linkedWorktree(t);
	const projectDir = path.join(repo, "app");
	const context = { skillsDir: path.join(root, "personal", "skills"), projectDir, host: "claude" };
	await fs.mkdir(projectDir, { recursive: true });
	const outside = path.join(root, ".claude", "skills", "outside-build");
	await fs.mkdir(outside, { recursive: true });
	await fs.writeFile(path.join(outside, "SKILL.md"), "Outside this repository.\n");
	assert.match(await manageSkill({ action: "create", name: "outside-build", description: "Build", body: "Steps." }, context), /^Created skill/);
});

test("Claude worktrees check main checkout skills only when their own root skills folder is missing", async (t) => {
	const { root, main, worktree } = await linkedWorktree(t);
	const inherited = path.join(main, ".claude", "skills", "build-app");
	await fs.mkdir(inherited, { recursive: true });
	await fs.writeFile(path.join(inherited, "SKILL.md"), "Main checkout's build steps.\n");
	const context = { skillsDir: path.join(root, "personal", "skills"), projectDir: worktree, host: "claude" };
	const args = { action: "create", name: "build-app", description: "Build", body: "Steps." };
	await assert.rejects(manageSkill(args, context), /already exists/);
	await fs.mkdir(path.join(worktree, ".claude", "skills"), { recursive: true });
	assert.match(await manageSkill(args, context), /^Created skill/);
	assert.equal(await fs.readFile(path.join(inherited, "SKILL.md"), "utf8"), "Main checkout's build steps.\n");
});

test("Claude worktrees inherit main checkout commands independently of their skills folder", async (t) => {
	const { root, main, worktree } = await linkedWorktree(t);
	const command = path.join(main, ".claude", "commands", "build-app.md");
	await fs.mkdir(path.dirname(command), { recursive: true });
	await fs.writeFile(command, "Main checkout's build command.\n");
	await fs.mkdir(path.join(worktree, ".claude", "skills"), { recursive: true });
	const context = { skillsDir: path.join(root, "personal", "skills"), projectDir: worktree, host: "claude" };
	const args = { action: "create", name: "build-app", description: "Build", body: "Steps." };
	await assert.rejects(manageSkill(args, context), /already exists/);
	await fs.mkdir(path.join(worktree, ".claude", "commands"), { recursive: true });
	assert.match(await manageSkill(args, context), /^Created skill/);
	assert.equal(await fs.readFile(command, "utf8"), "Main checkout's build command.\n");
});

test("Claude worktree checks preserve newlines and trailing spaces in checkout paths", async (t) => {
	const { root, main, worktree } = await linkedWorktree(t, { mainName: "main\ncheckout " });
	const inherited = path.join(main, ".claude", "skills", "build-app");
	await fs.mkdir(inherited, { recursive: true });
	await fs.writeFile(path.join(inherited, "SKILL.md"), "Main checkout's build steps.\n");
	const context = { skillsDir: path.join(root, "personal", "skills"), projectDir: worktree, host: "claude" };
	await assert.rejects(manageSkill({ action: "create", name: "build-app", description: "Build", body: "Steps." }, context), /already exists/);
});

test("Claude worktrees with unusual shared Git directories fail closed until they have their own skill and command folders", async (t) => {
	const { root, worktree } = await linkedWorktree(t, { separateGitDir: true });
	const context = { skillsDir: path.join(root, "personal", "skills"), projectDir: worktree, host: "claude" };
	const args = { action: "create", name: "build-app", description: "Build", body: "Steps." };
	await assert.rejects(manageSkill(args, context), /Cannot check inherited skills.*main checkout/);
	await assert.rejects(fs.access(path.join(context.skillsDir, "build-app")), { code: "ENOENT" });
	await fs.mkdir(path.join(worktree, ".claude", "skills"), { recursive: true });
	await fs.mkdir(path.join(worktree, ".claude", "commands"), { recursive: true });
	assert.match(await manageSkill(args, context), /^Created skill/);
});

test("a symlinked Claude library still checks commands in its configuration folder", async (t) => {
	const root = await tempDir(t);
	const config = path.join(root, ".claude");
	const target = path.join(root, "synced-skills");
	await fs.mkdir(path.join(config, "commands"), { recursive: true });
	await fs.mkdir(target);
	await fs.symlink(target, path.join(config, "skills"));
	await fs.writeFile(path.join(config, "commands", "build-app.md"), "User's build steps.\n");
	await assert.rejects(manageSkill({ action: "create", name: "build-app", description: "Build", body: "Steps." }, { skillsDir: path.join(config, "skills") }), /already exists/);
});

test("Claude creation refuses reserved names without preventing cleanup of old skills", async (t) => {
	const root = await tempDir(t);
	const context = { skillsDir: path.join(root, "skills"), host: "claude" };
	for (const name of ["synced", "anthropic-skills", " Synced "]) {
		await assert.rejects(manageSkill({ action: "create", name, description: "Build", body: "Steps." }, context), /reserved.*Claude/);
	}
	await assert.rejects(fs.access(context.skillsDir), { code: "ENOENT" });
	for (const name of ["synced", "anthropic-skills"]) {
		const dir = path.join(context.skillsDir, name);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, ".auto-learn"), "Created by an older version.\n");
		await fs.writeFile(path.join(dir, "SKILL.md"), "Old steps.\n");
		const { revision } = JSON.parse(await manageSkill({ action: "read", name }, context));
		await manageSkill({ action: "delete", name, revision }, context);
		await assert.rejects(fs.access(dir), { code: "ENOENT" });
	}
});
