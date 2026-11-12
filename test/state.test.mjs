import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
	acquireLock,
	appendLog,
	forgetSession,
	hasJob,
	hasSessionState,
	isValidSessionId,
	queueCapture,
	readSessionState,
	takeJob,
	writeSessionState,
} from "../scripts/lib/state.mjs";
import { tempDir } from "./helpers.mjs";

const job = (fields = {}) => ({ sessionId: "s1", transcriptPath: "/t/s1.jsonl", start: 100, end: 200, ...fields });

test("session state is kept per session, readable only by the user", async (t) => {
	const dir = await tempDir(t);
	assert.equal(await readSessionState(dir, "s1"), undefined);
	assert.equal(await hasSessionState(dir, "s1"), false);
	await writeSessionState(dir, "s1", { offset: 42, promptId: "p1", toolCalls: 3 });
	await writeSessionState(dir, "s2", { offset: 7, toolCalls: 0 });
	assert.deepEqual(await readSessionState(dir, "s1"), { offset: 42, promptId: "p1", toolCalls: 3 });
	assert.deepEqual(await readSessionState(dir, "s2"), { offset: 7, toolCalls: 0 });
	assert.equal(await hasSessionState(dir, "s1"), true);
	assert.equal((await fs.stat(path.join(dir, "sessions", "s2.json"))).mode & 0o777, 0o600);
});

test("malformed session state counts as absent, and malformed fields as unset", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "sessions", "s1.json");
	await writeSessionState(dir, "s1", { offset: 1, toolCalls: 0 });
	await fs.writeFile(file, "{not json");
	assert.equal(await readSessionState(dir, "s1"), undefined);
	await fs.writeFile(file, '{"offset":-5}');
	assert.equal(await readSessionState(dir, "s1"), undefined);
	await fs.writeFile(file, '{"offset":5,"promptId":7,"toolCalls":-1}');
	assert.deepEqual(await readSessionState(dir, "s1"), { offset: 5, toolCalls: 0 });
});

test("session ids that are not plain names are refused", async (t) => {
	const dir = await tempDir(t);
	for (const id of ["", "../x", "a/b", ".", "x".repeat(129), 5, undefined]) assert.equal(isValidSessionId(id), false);
	assert.equal(isValidSessionId("6f1c2a9e-0b6d-4c1e-9d6a-2f0f3c8d7e11"), true);
	await assert.rejects(writeSessionState(dir, "../escape", { offset: 1, toolCalls: 0 }), /session id/);
	await assert.rejects(queueCapture(dir, job({ sessionId: "a/b" })), /session id/);
});

test("takeJob hands each queued job out once, oldest turn first", async (t) => {
	const dir = await tempDir(t);
	assert.equal(await takeJob(dir, "s1"), undefined);
	await queueCapture(dir, job({ start: 1000, end: 12_000 }));
	await queueCapture(dir, job({ start: 100, end: 900 }));
	assert.equal(await hasJob(dir, "s1"), true);
	assert.deepEqual(await takeJob(dir, "s1"), job({ start: 100, end: 900 }));
	assert.deepEqual(await takeJob(dir, "s1"), job({ start: 1000, end: 12_000 }));
	assert.equal(await hasJob(dir, "s1"), false);
	assert.equal(await takeJob(dir, "s1"), undefined);
	assert.deepEqual(await fs.readdir(path.join(dir, "jobs", "s1")), []);
});

test("takeJob drops a malformed job and leaves files that are not jobs alone", async (t) => {
	const dir = await tempDir(t);
	await queueCapture(dir, job({ end: 200 }));
	const queue = path.join(dir, "jobs", "s1");
	await fs.writeFile(path.join(queue, "0000000000000100.json"), "{not json");
	await fs.writeFile(path.join(queue, "notes.txt"), "keep");
	assert.deepEqual(await takeJob(dir, "s1"), job({ end: 200 }));
	assert.equal(await takeJob(dir, "s1"), undefined);
	assert.deepEqual(await fs.readdir(queue), ["notes.txt"]);
});

test("queueCapture refuses a job without a usable transcript offset", async (t) => {
	const dir = await tempDir(t);
	for (const end of [-1, 1.5, "200", undefined]) await assert.rejects(queueCapture(dir, job({ end })), /offset/);
});

test("forgetSession drops the session's state and queued captures, and nothing else", async (t) => {
	const dir = await tempDir(t);
	await forgetSession(dir, "s1");
	for (const sessionId of ["s1", "s2"]) {
		await writeSessionState(dir, sessionId, { offset: 1, toolCalls: 0 });
		await queueCapture(dir, job({ sessionId }));
	}
	await forgetSession(dir, "s1");
	assert.equal(await hasSessionState(dir, "s1"), false);
	assert.equal(await hasJob(dir, "s1"), false);
	assert.equal(await hasSessionState(dir, "s2"), true);
	assert.equal(await hasJob(dir, "s2"), true);
});

test("acquireLock admits one holder until it releases", async (t) => {
	const dir = await tempDir(t);
	const lock = await acquireLock(dir, "s1");
	assert.ok(lock);
	assert.equal(await acquireLock(dir, "s1"), undefined);
	assert.ok(await acquireLock(dir, "s2"));
	await lock.release();
	assert.ok(await acquireLock(dir, "s1"));
});

test("a lock whose holder has exited, or that has not been refreshed in 20 minutes, is taken over", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "locks", "s1.lock");
	assert.ok(await acquireLock(dir, "s1"));
	assert.equal(await acquireLock(dir, "s1", { isAlive: () => true }), undefined);
	assert.ok(await acquireLock(dir, "s1", { isAlive: () => false }), "a dead holder's lock was kept");

	const old = new Date(Date.now() - 21 * 60 * 1000);
	await fs.utimes(file, old, old);
	assert.ok(await acquireLock(dir, "s1", { isAlive: () => true }), "a stale lock was kept");
});

test("refresh keeps a long-running holder's lock fresh", async (t) => {
	const dir = await tempDir(t);
	const file = path.join(dir, "locks", "s1.lock");
	const lock = await acquireLock(dir, "s1");
	const old = new Date(Date.now() - 21 * 60 * 1000);
	await fs.utimes(file, old, old);
	await lock.refresh();
	assert.equal(await acquireLock(dir, "s1", { isAlive: () => true }), undefined);
});

test("a lock file whose holder has not written its pid yet is not taken over", async (t) => {
	const dir = await tempDir(t);
	await fs.mkdir(path.join(dir, "locks"));
	await fs.writeFile(path.join(dir, "locks", "s1.lock"), "");
	assert.equal(await acquireLock(dir, "s1", { isAlive: () => false }), undefined);
});

test("appendLog writes one JSON object per line and keeps one rotated file", async (t) => {
	const dir = await tempDir(t);
	await appendLog(dir, { event: "skip", reason: "plan mode" }, new Date("2026-01-02T03:04:05Z"));
	const log = path.join(dir, "auto-learn.log");
	assert.deepEqual(JSON.parse(await fs.readFile(log, "utf8")), { time: "2026-01-02T03:04:05.000Z", event: "skip", reason: "plan mode" });
	assert.equal((await fs.stat(log)).mode & 0o777, 0o600);

	await fs.writeFile(log, "x".repeat(1024 * 1024));
	await appendLog(dir, { event: "after-rotation" });
	assert.equal((await fs.stat(`${log}.1`)).size, 1024 * 1024);
	assert.match(await fs.readFile(log, "utf8"), /^\{"time":"[^"]+","event":"after-rotation"\}\n$/);
});
