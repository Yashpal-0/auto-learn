#!/usr/bin/env node
// The capture worker the Stop hook starts: captures the session's queued turns, logs each outcome, then exits.
import { captureAgyTurn } from "./lib/agy.mjs";
import { captureTurn, drainQueue } from "./lib/capture.mjs";
import { captureCodexTurn } from "./lib/codex.mjs";
import { captureCopilotTurn } from "./lib/copilot.mjs";
import { dataDir, parseHost } from "./lib/config.mjs";
import { appendLog, hasSessionState } from "./lib/state.mjs";

const SESSION_CHECK_MS = 1000;
// Codex queues a turn again each time a Stop hook continues it, and this worker reviews each turn once.
const reviewedTurns = new Set();

const sessionId = process.argv[2];
// The hook that queued the job names its host, which is what tells where the queue is.
const host = parseHost(process.argv.slice(3));
const dir = dataDir(process.env, host);
const controller = new AbortController();
const stop = (reason) => controller.abort(reason);
process.once("SIGTERM", () => stop("the worker received SIGTERM"));
// The SessionEnd hook deletes the session's state, so a capture stops once its session ends; agy has no such hook.
const watcher =
	host === "agy"
		? undefined
		: setInterval(() => {
				hasSessionState(dir, sessionId).then(
					(isOpen) => isOpen || stop("the session ended"),
					(error) => stop(`checking the session failed: ${error.message}`),
				);
			}, SESSION_CHECK_MS);

try {
	await drainQueue(
		dir,
		sessionId,
		async (job) => {
			let record;
			try {
				if (job.host === "codex") record = await captureCodexTurn(job, { signal: controller.signal, reviewedTurns });
				else if (job.host === "copilot") record = await captureCopilotTurn(job, { signal: controller.signal });
				else if (job.host === "agy") record = await captureAgyTurn(job, { signal: controller.signal });
				else record = await captureTurn(job, { signal: controller.signal });
			} catch (error) {
				// The worker has no terminal, so the log is where a failed capture is reported; the next job still runs.
				record = { outcome: "error", error: error.message };
			}
			await appendLog(dir, { event: "capture", session: sessionId, ...record });
		},
		controller.signal,
	);
} catch (error) {
	await appendLog(dir, { event: "capture", session: sessionId, outcome: "error", error: error.message });
	process.exitCode = 1;
} finally {
	clearInterval(watcher);
}
