import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MAX_SKILL_BYTES, manageSkill } from "../scripts/lib/skills.mjs";
import { tempDir } from "./helpers.mjs";

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
