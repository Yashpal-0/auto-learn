import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { removeConversation, reviewStoreDir, sweepStore } from "../scripts/lib/agy-store.mjs";
import { tempDir } from "./helpers.mjs";

const ONE = "5ee594ec-ee8c-4113-b3c8-dbb98dfadefc";
const TWO = "0d55435a-27e4-4a9b-b0f0-2f3c1e6d8a11";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 21, 12);

const exists = (file) => fs.access(file).then(() => true, () => false);

/** A review store as agy 1.5.14 leaves it: one conversation's files beside the files every run shares. */
async function store(t, ids = [ONE, TWO]) {
	const root = await tempDir(t);
	const dir = path.join(root, "store");
	for (const file of ["conversation_summaries.db", "installation_id", "cache/last_conversations.json", "updater/last_check.timestamp"]) {
		await write(dir, file);
	}
	for (const id of ids) await conversation(dir, id);
	return { root, dir };
}

async function write(dir, relative) {
	await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
	await fs.writeFile(path.join(dir, relative), "x");
}

/** The files of one conversation, relative to the store. */
async function conversation(dir, id, { sidecars = false } = {}) {
	const files = [`brain/${id}/.system_generated/logs/transcript_full.jsonl`, `conversations/${id}.db`, `presence/${id}.lock`];
	if (sidecars) files.push(`conversations/${id}.db-wal`, `conversations/${id}.db-shm`);
	for (const file of files) await write(dir, file);
	return files;
}

/** Sets the age of every file of a conversation, the brain folder included. */
async function age(dir, id, ms) {
	const when = new Date(NOW - ms);
	for (const file of [`brain/${id}`, `conversations/${id}.db`, `conversations/${id}.db-wal`, `conversations/${id}.db-shm`, `presence/${id}.lock`]) {
		await fs.utimes(path.join(dir, file), when, when).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

test("reviewStoreDir is the folder agy is told to use for review conversations", () => {
	assert.equal(reviewStoreDir("/home/me"), "/home/me/.gemini/auto-learn-review");
});

test("removeConversation removes one conversation's files, the sidecar files of its database too, and nothing else", async (t) => {
	const { dir } = await store(t, [TWO]);
	const files = await conversation(dir, ONE, { sidecars: true });
	assert.equal(await removeConversation(dir, ONE), undefined);
	for (const file of files) assert.equal(await exists(path.join(dir, file)), false, file);
	assert.equal(await exists(path.join(dir, "brain", ONE)), false);
	for (const kept of [`brain/${TWO}`, `conversations/${TWO}.db`, `presence/${TWO}.lock`, "conversation_summaries.db", "installation_id", "cache/last_conversations.json"]) {
		assert.equal(await exists(path.join(dir, kept)), true, kept);
	}
});

test("removeConversation has nothing to say when the conversation, or the store, is already gone", async (t) => {
	const { root, dir } = await store(t, []);
	assert.equal(await removeConversation(dir, ONE), undefined);
	assert.equal(await removeConversation(path.join(root, "no-store"), ONE), undefined);
});

test("removeConversation refuses anything but a lowercase UUID and deletes nothing, however the name climbs out of the store", async (t) => {
	const { root, dir } = await store(t);
	await write(root, "decoy/brain/keep.txt");
	await write(root, "keep.txt");
	const refused = [
		"../decoy",
		"../../" + path.basename(root),
		"..",
		".",
		"/",
		root,
		"a/b",
		"",
		"5ee594ec",
		ONE.toUpperCase(),
		`${ONE}/..`,
		`${ONE}/../${TWO}`,
		`${ONE}\n`,
		`${ONE}\0`,
		` ${ONE}`,
		undefined,
		null,
		42,
		{ toString: () => ONE },
		[ONE],
	];
	for (const id of refused) {
		assert.equal(await removeConversation(dir, id), "not a conversation id", JSON.stringify(id));
	}
	for (const kept of ["../decoy/brain/keep.txt", "../keep.txt", `brain/${ONE}`, `brain/${TWO}`, `conversations/${ONE}.db`]) {
		assert.equal(await exists(path.join(dir, kept)), true, kept);
	}
});

test("removeConversation removes a link named like the conversation, never what it points to", async (t) => {
	const { root, dir } = await store(t, []);
	await write(root, "outside/keep.txt");
	await fs.mkdir(path.join(dir, "brain"), { recursive: true });
	await fs.symlink(path.join(root, "outside"), path.join(dir, "brain", ONE));
	assert.equal(await removeConversation(dir, ONE), undefined);
	assert.equal(await exists(path.join(dir, "brain", ONE)), false);
	assert.equal(await exists(path.join(root, "outside", "keep.txt")), true);
});

test("removeConversation says which files it could not remove and why, without the store's location", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root can remove files from a read-only folder");
	const { dir } = await store(t, []);
	await conversation(dir, ONE);
	const brain = path.join(dir, "brain");
	await fs.chmod(brain, 0o500);
	try {
		const failure = await removeConversation(dir, ONE);
		assert.match(failure, /^could not remove brain\/5ee594ec-ee8c-4113-b3c8-dbb98dfadefc: EACCES$/);
		assert.equal(await exists(path.join(dir, "conversations", `${ONE}.db`)), false, "the other files are still removed");
	} finally {
		await fs.chmod(brain, 0o700);
	}
});

test("sweepStore removes conversations nothing has touched for an hour and keeps the rest of the store", async (t) => {
	const { dir } = await store(t, [ONE, TWO]);
	await age(dir, ONE, 2 * HOUR);
	await age(dir, TWO, 5 * 60_000);
	assert.equal(await sweepStore(dir, { now: NOW }), undefined);
	assert.equal(await exists(path.join(dir, "brain", ONE)), false);
	assert.equal(await exists(path.join(dir, "conversations", `${ONE}.db`)), false);
	assert.equal(await exists(path.join(dir, "presence", `${ONE}.lock`)), false);
	assert.equal(await exists(path.join(dir, "brain", TWO)), true, "a review that may still be running");
	assert.equal(await exists(path.join(dir, "conversations", `${TWO}.db`)), true);
	for (const kept of ["conversation_summaries.db", "installation_id", "cache/last_conversations.json", "updater/last_check.timestamp"]) {
		assert.equal(await exists(path.join(dir, kept)), true, kept);
	}
});

test("sweepStore keeps a conversation while any one of its files is fresh, and goes by exactly the age it is given", async (t) => {
	const { dir } = await store(t, [ONE, TWO]);
	await age(dir, ONE, 3 * HOUR);
	const fresh = new Date(NOW - 60_000);
	await fs.utimes(path.join(dir, "conversations", `${ONE}.db`), fresh, fresh);
	await age(dir, TWO, HOUR);
	await sweepStore(dir, { now: NOW });
	assert.equal(await exists(path.join(dir, "brain", ONE)), true, "its database is still being written");
	assert.equal(await exists(path.join(dir, "brain", TWO)), true, "an hour old exactly is not older than an hour");
	await sweepStore(dir, { now: NOW + 1000 });
	assert.equal(await exists(path.join(dir, "brain", TWO)), false);
	await sweepStore(dir, { now: NOW, maxAgeMs: 30_000 });
	assert.equal(await exists(path.join(dir, "brain", ONE)), false);
});

test("sweepStore touches only entries named for a conversation, also when they are old", async (t) => {
	const { dir } = await store(t, []);
	const odd = ["brain/notes", "brain/5ee594ec", `brain/${ONE.toUpperCase()}`, `conversations/${ONE}.txt`, `conversations/${ONE}`, `presence/${ONE}.db`, "conversations/x.db"];
	for (const file of odd) await write(dir, file);
	const old = new Date(NOW - 9 * DAY);
	for (const file of odd) await fs.utimes(path.join(dir, file), old, old);
	assert.equal(await sweepStore(dir, { now: NOW }), undefined);
	for (const file of odd) assert.equal(await exists(path.join(dir, file)), true, file);
});

test("sweepStore removes agy's logs after a day, and only those", async (t) => {
	const { dir } = await store(t, []);
	const logs = { "log/cli-20261119_090000.log": 2 * DAY, "log/cli-20261121_110000.log": HOUR, "log/notes.txt": 9 * DAY, "cli-old.log": 9 * DAY };
	for (const [file, ms] of Object.entries(logs)) {
		await write(dir, file);
		const when = new Date(NOW - ms);
		await fs.utimes(path.join(dir, file), when, when);
	}
	assert.equal(await sweepStore(dir, { now: NOW }), undefined);
	assert.equal(await exists(path.join(dir, "log/cli-20261119_090000.log")), false);
	for (const kept of ["log/cli-20261121_110000.log", "log/notes.txt", "cli-old.log"]) assert.equal(await exists(path.join(dir, kept)), true, kept);
	await sweepStore(dir, { now: NOW, logMaxAgeMs: 30 * 60_000 });
	assert.equal(await exists(path.join(dir, "log/cli-20261121_110000.log")), false);
});

test("sweepStore leaves a store that is missing, or only partly there, alone", async (t) => {
	const { root, dir } = await store(t, []);
	assert.equal(await sweepStore(path.join(root, "no-store"), { now: NOW }), undefined);
	assert.equal(await sweepStore(dir, { now: NOW }), undefined);
});

test("sweepStore reports a failure and still removes what it can", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root can remove files from a read-only folder");
	const { dir } = await store(t, [ONE, TWO]);
	await age(dir, ONE, 2 * HOUR);
	await age(dir, TWO, 2 * HOUR);
	const presence = path.join(dir, "presence");
	await fs.chmod(presence, 0o500);
	try {
		const failure = await sweepStore(dir, { now: NOW });
		assert.match(failure, /^could not remove .*presence\/[0-9a-f-]{36}\.lock: EACCES/);
		assert.equal(await exists(path.join(dir, "brain", ONE)), false);
		assert.equal(await exists(path.join(dir, "brain", TWO)), false);
	} finally {
		await fs.chmod(presence, 0o700);
	}
});
