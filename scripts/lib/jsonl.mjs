// Reads JSON Lines files that another process may still be appending to,
// such as session transcripts: complete lines only, so a line still being
// written is left for the next read.
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

/** Calls `visit` with each complete line that starts in [start, end), and returns the offset just past the last one. */
export async function readLines(file, start, end, visit) {
	let next = start;
	if (end <= start) return next;
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.alloc(CHUNK_BYTES);
		const split = lineSplitter(MAX_LINE_BYTES, visit);
		for (let position = start; position < end; ) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, end - position), position);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			split(chunk);
			const lastNewline = chunk.lastIndexOf(NEWLINE);
			if (lastNewline !== -1) next = position + lastNewline + 1;
			position += bytesRead;
		}
	} finally {
		await handle.close();
	}
	return next;
}

/**
 * Splits bytes into lines. Returns a function to call with each chunk in
 * turn, which calls `visit` with each complete line, without its newline,
 * and leaves out every line over `limit` bytes. A line may share memory with
 * its chunk, so `visit` must not keep it; what the splitter holds of a
 * partial line it copies, so the caller may reuse a chunk's buffer.
 */
export function lineSplitter(limit, visit) {
	let pending = [];
	let pendingBytes = 0;
	let isSkippingLine = false;
	return (chunk) => {
		let from = 0;
		for (let newline = chunk.indexOf(NEWLINE); newline !== -1; newline = chunk.indexOf(NEWLINE, from)) {
			const piece = chunk.subarray(from, newline);
			if (!isSkippingLine && pendingBytes + piece.length <= limit) visit(pendingBytes ? Buffer.concat([...pending, piece]) : piece);
			pending = [];
			pendingBytes = 0;
			isSkippingLine = false;
			from = newline + 1;
		}
		const rest = chunk.subarray(from);
		if (isSkippingLine || rest.length === 0) return;
		if (pendingBytes + rest.length > limit) {
			isSkippingLine = true;
			pending = [];
			pendingBytes = 0;
		} else {
			pending.push(Buffer.from(rest));
			pendingBytes += rest.length;
		}
	};
}

/** The line's JSON value, or undefined when the line is not valid JSON. */
export function parseLine(line) {
	try {
		return JSON.parse(line.toString("utf8"));
	} catch {
		// A torn line, such as one a range starts in the middle of, carries nothing to read.
		return undefined;
	}
}

/**
 * Reads the lines of `file` from byte `position` on, waiting for more as they
 * are appended, and calls `visit` with each until it returns something other
 * than undefined, which this returns. Returns undefined when `signal` aborts
 * or `timeoutMs` passes first.
 */
export async function followLines(file, position, visit, { signal, timeoutMs, pollDelay = defaultPollDelay }) {
	const started = performance.now();
	for (;;) {
		let outcome;
		position = await readLines(file, position, (await fs.stat(file)).size, (line) => {
			if (outcome === undefined) outcome = visit(line);
		});
		if (outcome !== undefined) return outcome;
		if (signal?.aborted) return undefined;
		const elapsed = performance.now() - started;
		if (elapsed >= timeoutMs) return undefined;
		try {
			await sleep(Math.min(pollDelay(elapsed), timeoutMs - elapsed), undefined, { signal });
		} catch (error) {
			if (error.name !== "AbortError") throw error;
		}
	}
}

/** Poll often at first, since a turn's end usually lands within a second, then back off while slow Stop hooks run. */
function defaultPollDelay(elapsedMs) {
	return elapsedMs < 10_000 ? 250 : 1000;
}
