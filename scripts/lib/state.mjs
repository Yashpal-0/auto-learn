// Plugin state in the data directory: where each session stands in its
// transcript, the capture queue with its locks, and the activity log. A
// missing or malformed state file counts as absent; the next write replaces it.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./files.mjs";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// A queued job is named by the transcript offset where its turn ended, zero-padded so names sort in queue order.
const JOB_FILE = /^\d{16}\.json$/;
const STALE_LOCK_MS = 20 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/** Whether `value` is a session id that is safe to use as a file name. */
export function isValidSessionId(value) {
	return typeof value === "string" && SESSION_ID.test(value);
}

function sessionFile(dataDir, kind, sessionId, extension) {
	if (!isValidSessionId(sessionId)) throw new Error(`Refusing the session id ${JSON.stringify(sessionId)}: it is not a plain name.`);
	return path.join(dataDir, kind, `${sessionId}${extension}`);
}

async function readJson(file) {
	let text;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function writeJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR });
	await writeFileAtomic(file, `${JSON.stringify(value)}\n`, PRIVATE_FILE);
}

async function exists(file) {
	try {
		await fs.access(file);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Where the session's next turn starts in its transcript, with the prompt id
 * and tool call count of the turn that stopped last, for Copilot the id of
 * the fusion turn still open at that stop, and for Antigravity CLI whether a
 * capture of that turn is queued, or undefined when nothing is saved.
 *
 * @returns {Promise<{offset: number, promptId?: string, toolCalls: number, fusion?: string, queued?: true} | undefined>}
 */
export async function readSessionState(dataDir, sessionId) {
	const value = await readJson(sessionFile(dataDir, "sessions", sessionId, ".json"));
	if (!Number.isSafeInteger(value?.offset) || value.offset < 0) return undefined;
	return {
		offset: value.offset,
		...(typeof value.promptId === "string" ? { promptId: value.promptId } : {}),
		...(typeof value.fusion === "string" && value.fusion !== "" ? { fusion: value.fusion } : {}),
		...(value.queued === true ? { queued: true } : {}),
		toolCalls: Number.isSafeInteger(value.toolCalls) && value.toolCalls >= 0 ? value.toolCalls : 0,
	};
}

/** @param {{offset: number, promptId?: string, toolCalls: number, fusion?: string, queued?: true}} state */
export async function writeSessionState(dataDir, sessionId, state) {
	await writeJson(sessionFile(dataDir, "sessions", sessionId, ".json"), state);
}

/** Whether the session is still open: its state is deleted when the session ends. */
export async function hasSessionState(dataDir, sessionId) {
	return exists(sessionFile(dataDir, "sessions", sessionId, ".json"));
}

/** Forgets a session that ended: its state and its queued captures. A capture still running for it sees the state gone and stops. */
export async function forgetSession(dataDir, sessionId) {
	await Promise.all([
		fs.rm(sessionFile(dataDir, "sessions", sessionId, ".json"), { force: true }),
		fs.rm(sessionFile(dataDir, "jobs", sessionId, ""), { recursive: true, force: true }),
	]);
}

/**
 * Forgets the sessions whose state was last written more than `maxAgeMs` ago,
 * with their queued captures. A host with no session-end hook never forgets a
 * session itself.
 */
export async function pruneSessions(dataDir, maxAgeMs, now = Date.now()) {
	const folder = path.join(dataDir, "sessions");
	let names;
	try {
		names = await fs.readdir(folder);
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	for (const name of names) {
		const sessionId = name.slice(0, -".json".length);
		if (!name.endsWith(".json") || !isValidSessionId(sessionId)) continue;
		let stats;
		try {
			stats = await fs.stat(path.join(folder, name));
		} catch (error) {
			// Forgotten by the session's own host in the meantime.
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (now - stats.mtimeMs > maxAgeMs) await forgetSession(dataDir, sessionId);
	}
}

/**
 * Queues a capture of the turn that ended when the transcript was `job.end`
 * bytes long. Captures run in the order their turns ended. A Codex job names
 * its turn by id instead of by where it starts.
 *
 * @param {{host?: "codex" | "copilot" | "agy", sessionId: string, transcriptPath: string, start?: number, end: number, turnId?: string, stopId?: string, fusion?: string, toolCalls?: number, projectDir?: string, model?: string, modelProvider?: string, effort?: string}} job
 */
export async function queueCapture(dataDir, job) {
	if (!Number.isSafeInteger(job.end) || job.end < 0) throw new Error(`Refusing to queue a capture at transcript offset ${job.end}.`);
	await writeJson(path.join(sessionFile(dataDir, "jobs", job.sessionId, ""), `${String(job.end).padStart(16, "0")}.json`), job);
}

/** Removes the session's oldest queued job and returns it, or undefined when none is queued. */
export async function takeJob(dataDir, sessionId) {
	const dir = sessionFile(dataDir, "jobs", sessionId, "");
	for (const name of await queuedJobNames(dir)) {
		const file = path.join(dir, name);
		const taken = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.taken`;
		try {
			await fs.rename(file, taken);
		} catch (error) {
			// Taken by another worker, or dropped when the session ended.
			if (error.code === "ENOENT") continue;
			throw error;
		}
		let job;
		try {
			job = await readJson(taken);
		} finally {
			await fs.rm(taken, { force: true });
		}
		if (job !== undefined) return job;
	}
	return undefined;
}

export async function hasJob(dataDir, sessionId) {
	return (await queuedJobNames(sessionFile(dataDir, "jobs", sessionId, ""))).length > 0;
}

async function queuedJobNames(dir) {
	let names;
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	return names.filter((name) => JOB_FILE.test(name)).sort();
}

/**
 * Takes the session's capture lock, or returns undefined while another live
 * worker holds it. A lock is taken over when its holder has exited or it has
 * not been refreshed for 20 minutes.
 *
 * @returns {Promise<{refresh(): Promise<void>, release(): Promise<void>} | undefined>}
 */
export async function acquireLock(dataDir, sessionId, { isAlive = isProcessAlive } = {}) {
	const file = sessionFile(dataDir, "locks", sessionId, ".lock");
	await fs.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.writeFile(file, `${process.pid}\n`, { flag: "wx", mode: PRIVATE_FILE });
			return {
				refresh: async () => {
					const now = new Date();
					await fs.utimes(file, now, now);
				},
				release: () => fs.rm(file, { force: true }),
			};
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		if (!(await isStaleLock(file, isAlive))) return undefined;
		await fs.rm(file, { force: true });
	}
	return undefined;
}

async function isStaleLock(file, isAlive) {
	let stats;
	let text;
	try {
		[stats, text] = await Promise.all([fs.stat(file), fs.readFile(file, "utf8")]);
	} catch (error) {
		if (error.code === "ENOENT") return true;
		throw error;
	}
	if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) return true;
	// An empty file is a lock whose holder has not written its pid yet.
	const pid = Number.parseInt(text, 10);
	return Number.isSafeInteger(pid) && pid > 0 && !isAlive(pid);
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return error.code === "EPERM";
	}
}

/** Appends one record to the activity log, keeping one rotated file once the log reaches 1 MiB. */
export async function appendLog(dataDir, record, now = new Date()) {
	const file = path.join(dataDir, "auto-learn.log");
	await fs.mkdir(dataDir, { recursive: true, mode: PRIVATE_DIR });
	try {
		if ((await fs.stat(file)).size >= MAX_LOG_BYTES) await fs.rename(file, `${file}.1`);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await fs.appendFile(file, `${JSON.stringify({ time: now.toISOString(), ...record })}\n`, { mode: PRIVATE_FILE });
}
