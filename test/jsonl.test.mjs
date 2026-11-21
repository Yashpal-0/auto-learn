import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { lineSplitter, readLines } from "../scripts/lib/jsonl.mjs";
import { tempDir } from "./helpers.mjs";

function split(chunks, limit) {
	const lines = [];
	const push = lineSplitter(limit, (line) => lines.push(line.toString("utf8")));
	for (const chunk of chunks) push(Buffer.from(chunk));
	return lines;
}

test("lineSplitter joins a line that spans chunks and holds a partial last line until its newline comes", () => {
	assert.deepEqual(split(["a\nb", "c", "d\ne"], 10), ["a", "bcd"]);
});

test("lineSplitter leaves out every line over its limit, wherever the chunks break it", () => {
	assert.deepEqual(split(["12345\n"], 5), ["12345"]);
	// The newline comes in the chunk that takes the line over the limit.
	assert.deepEqual(split(["1234", "56\nok\n"], 5), ["ok"]);
	assert.deepEqual(split(["123456", "7\nok\n"], 5), ["ok"]);
	assert.deepEqual(split(["1234", "5", "6", "\nok\n"], 5), ["ok"]);
});

test("lineSplitter copies the partial line it holds, so the caller may reuse a chunk's buffer", () => {
	const lines = [];
	const push = lineSplitter(10, (line) => lines.push(line.toString("utf8")));
	const buffer = Buffer.from("ab");
	push(buffer);
	buffer.write("xy");
	push(Buffer.from("c\n"));
	assert.deepEqual(lines, ["abc"]);
});

test("lineSplitter tells each line's offset in bytes, counting the multibyte characters and the lines it leaves out", () => {
	const seen = [];
	const push = lineSplitter(5, (line, offset) => seen.push([line.toString("utf8"), offset]), 100);
	for (const chunk of ["é\nab", "c\n1234", "5678\nok\n"]) push(Buffer.from(chunk));
	// "é\n" is three bytes, "abc\n" four, and the nine bytes of the line over the limit are left out.
	assert.deepEqual(seen, [["é", 100], ["abc", 103], ["ok", 116]]);
});

test("readLines tells each line's offset in the file, from the byte it started at, across its chunks", async (t) => {
	const file = path.join(await tempDir(t), "lines.jsonl");
	// The second line crosses the first megabyte, where readLines reads its next chunk.
	const lines = ["héllo", "x".repeat(1024 * 1024 + 7), "日本語", "last"];
	await fs.writeFile(file, lines.map((line) => `${line}\n`).join(""));
	const size = (await fs.stat(file)).size;
	const first = Buffer.byteLength("héllo\n");
	const second = first + 1024 * 1024 + 7 + 1;
	const third = second + Buffer.byteLength("日本語\n");
	const seen = [];
	const next = await readLines(file, first, size, (line, offset) => seen.push([line.length, offset]));
	assert.deepEqual(seen, [[1024 * 1024 + 7, first], [Buffer.byteLength("日本語"), second], [4, third]]);
	assert.equal(next, size);
});
