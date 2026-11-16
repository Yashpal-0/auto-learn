import assert from "node:assert/strict";
import { test } from "node:test";
import { lineSplitter } from "../scripts/lib/jsonl.mjs";

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
