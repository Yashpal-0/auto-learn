// The private conversation store an agy review runs in (`--app_data_dir`), and
// its cleanup. A review's prompt holds an excerpt of the user's work; agy writes
// it to the conversation's files (checked with agy 1.5.14: `brain/<id>/` and
// `conversations/<id>.db`, nothing in the shared summaries, cache or logs), so
// each review removes its own conversation when it ends, and a later review
// sweeps what a crashed one left.
import fs from "node:fs/promises";
import path from "node:path";

export const REVIEW_STORE_NAME = "auto-learn-review";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CONVERSATION_ID = new RegExp(`^${UUID}$`);
/** Per folder, the names agy gives one conversation's entries, with the id captured. */
const ENTRY_NAMES = {
	brain: new RegExp(`^(${UUID})$`),
	conversations: new RegExp(`^(${UUID})\\.db(?:-wal|-shm)?$`),
	presence: new RegExp(`^(${UUID})\\.lock$`),
};
const LOG_NAME = /^cli-.*\.log$/;

/** Where agy keeps the review conversations, as the `~/.gemini/<name>` that `--app_data_dir=<name>` selects. */
export function reviewStoreDir(home) {
	return path.join(home, ".gemini", REVIEW_STORE_NAME);
}

/**
 * Removes every file agy keeps for one conversation, whether or not it was ever
 * written. The id comes from agy's output, so only a lowercase UUID, as agy
 * writes it, is allowed to name a path.
 *
 * @param {string} storeDir the review store
 * @param {unknown} conversationId
 * @returns {Promise<string | undefined>} what could not be removed, or undefined
 */
export async function removeConversation(storeDir, conversationId) {
	if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) return "not a conversation id";
	const failures = [];
	const relatives = [`brain/${conversationId}`, ...["db", "db-wal", "db-shm"].map((suffix) => `conversations/${conversationId}.${suffix}`), `presence/${conversationId}.lock`];
	for (const relative of relatives) {
		try {
			await fs.rm(path.join(storeDir, relative), { recursive: true, force: true });
		} catch (error) {
			failures.push(`${relative}: ${error.code ?? "failed"}`);
		}
	}
	return failures.length > 0 ? `could not remove ${failures.join(", ")}` : undefined;
}

/**
 * Removes the conversations whose files have not changed for `maxAgeMs`, and
 * agy's own logs older than `logMaxAgeMs`. A conversation stays while any one of
 * its files is newer, so a review that is still running is never touched.
 *
 * @param {string} storeDir the review store
 * @param {{ now?: number, maxAgeMs?: number, logMaxAgeMs?: number }} options
 * @returns {Promise<string | undefined>} the first failure, or undefined; the rest still runs
 */
export async function sweepStore(storeDir, { now = Date.now(), maxAgeMs = HOUR_MS, logMaxAgeMs = DAY_MS } = {}) {
	const failures = [];
	const newest = new Map();
	for (const [folder, pattern] of Object.entries(ENTRY_NAMES)) {
		for (const { name, mtimeMs } of await listing(path.join(storeDir, folder), pattern, failures)) {
			const id = pattern.exec(name)[1];
			newest.set(id, Math.max(newest.get(id) ?? 0, mtimeMs));
		}
	}
	for (const [id, mtimeMs] of newest) {
		if (mtimeMs >= now - maxAgeMs) continue;
		const failure = await removeConversation(storeDir, id);
		if (failure) failures.push(failure);
	}
	for (const { name, mtimeMs } of await listing(path.join(storeDir, "log"), LOG_NAME, failures)) {
		if (mtimeMs >= now - logMaxAgeMs) continue;
		try {
			await fs.rm(path.join(storeDir, "log", name), { force: true });
		} catch (error) {
			failures.push(`could not remove log/${name}: ${error.code ?? "failed"}`);
		}
	}
	return failures[0];
}

/** The entries of `folder` whose names match, with their modification times; a missing folder has none. */
async function listing(folder, pattern, failures) {
	let names;
	try {
		names = await fs.readdir(folder);
	} catch (error) {
		if (error.code !== "ENOENT") failures.push(`could not read ${path.basename(folder)}: ${error.code ?? "failed"}`);
		return [];
	}
	const found = [];
	for (const name of names.filter((candidate) => pattern.test(candidate))) {
		try {
			found.push({ name, mtimeMs: (await fs.lstat(path.join(folder, name))).mtimeMs });
		} catch (error) {
			// Removed by its own review in the meantime.
			if (error.code !== "ENOENT") failures.push(`could not read ${path.basename(folder)}/${name}: ${error.code ?? "failed"}`);
		}
	}
	return found;
}
