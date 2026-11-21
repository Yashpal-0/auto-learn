import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { isAttendedSession, isCliTranscript } from "../scripts/lib/agy-session.mjs";
import { tempDir } from "./helpers.mjs";

/**
 * A /proc folder with one entry per process: `stat` the way Linux writes it,
 * `cmdline` NUL-separated, and `exe` as a link when the process has one.
 */
async function procTree(t, processes) {
	const root = await tempDir(t);
	for (const { pid, ppid, comm = "proc", argv, exe } of processes) {
		const dir = path.join(root, String(pid));
		await fs.mkdir(dir);
		await fs.writeFile(path.join(dir, "stat"), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1 1 1\n`);
		if (argv) await fs.writeFile(path.join(dir, "cmdline"), `${argv.join("\0")}\0`);
		if (exe) await fs.symlink(exe, path.join(dir, "exe"));
	}
	return root;
}

/** The hook's own node process, its `sh -c` and an agy started with `agyArgv`. */
const underAgy = (agyArgv, agy = {}) => [
	{ pid: 300, ppid: 200, comm: "node", argv: ["node", "./scripts/hook.mjs", "stop", "--host=agy"] },
	{ pid: 200, ppid: 100, comm: "sh", argv: ["sh", "-c", "node ./scripts/hook.mjs stop --host=agy"] },
	{ pid: 100, ppid: 1, comm: "agy", argv: agyArgv, ...agy },
	{ pid: 1, ppid: 0, comm: "init", argv: ["/sbin/init"] },
];

test("isAttendedSession says a person is at the keyboard when agy was started without a script flag", async (t) => {
	for (const argv of [["agy"], ["/home/me/.local/bin/agy"], ["agy", "-i", "fix the build"], ["agy", "--prompt-interactive", "x"], ["agy", "--settings", '{"a":"-p"}']]) {
		assert.equal(await isAttendedSession(300, await procTree(t, underAgy(argv))), true, argv.join(" "));
	}
});

test("isAttendedSession says a script runs agy for -p, --print and --prompt in every spelling, acp, --hub and --remote-agent", async (t) => {
	const scripts = [
		["agy", "-p", "do it"],
		["agy", "--p", "do it"],
		["agy", "-p=do it"],
		["agy", "--print=do it"],
		["agy", "-print", "x"],
		["agy", "--prompt", "x"],
		["agy", "--model", "m", "-p", "x"],
		["agy", "acp"],
		["agy", "--hub", "--hub-port=41757", "--app_data_dir=antigravity"],
		["agy", "--remote-agent"],
	];
	for (const argv of scripts) {
		assert.equal(await isAttendedSession(300, await procTree(t, underAgy(argv))), false, argv.join(" "));
	}
});

test("isAttendedSession finds agy by its executable when argv[0] is something else, also after an update replaced the file", async (t) => {
	const root = await procTree(t, underAgy(["renamed", "-p", "x"], { exe: "/home/me/.local/bin/agy (deleted)" }));
	assert.equal(await isAttendedSession(300, root), false);
	const named = await procTree(t, underAgy(["renamed"], { exe: "/home/me/.local/bin/agy" }));
	assert.equal(await isAttendedSession(300, named), true);
});

test("isAttendedSession does not mistake another program for agy", async (t) => {
	for (const name of ["agy-helper", "xagy", "agy.sh"]) {
		assert.equal(await isAttendedSession(300, await procTree(t, underAgy([name, "-p", "x"]))), undefined, name);
	}
});

test("isAttendedSession reads a parent id after the last parenthesis, since a process name may hold parentheses and spaces", async (t) => {
	const tree = underAgy(["agy"]);
	tree[1].comm = "sh) S 999 (x";
	assert.equal(await isAttendedSession(300, await procTree(t, tree)), true);
});

test("isAttendedSession cannot tell without an agy ancestor, a readable command line, or a bounded parent chain", async (t) => {
	assert.equal(await isAttendedSession(300, await procTree(t, underAgy(["agy"]).filter((p) => p.pid !== 100))), undefined);
	const unreadable = underAgy(["agy"]);
	delete unreadable[2].argv;
	assert.equal(await isAttendedSession(300, await procTree(t, unreadable)), undefined);
	// agy known by its executable alone, with no command line to read: not a person until proven.
	const byExecutableOnly = underAgy(undefined, { exe: "/home/me/.local/bin/agy" });
	assert.equal(await isAttendedSession(300, await procTree(t, byExecutableOnly)), undefined);
	assert.equal(await isAttendedSession(300, path.join(await tempDir(t), "no-such-proc")), undefined);
	const loop = [
		{ pid: 300, ppid: 200, argv: ["node"] },
		{ pid: 200, ppid: 300, argv: ["sh"] },
	];
	assert.equal(await isAttendedSession(300, await procTree(t, loop)), undefined);
	const deep = Array.from({ length: 40 }, (_, i) => ({ pid: 1000 + i, ppid: 1001 + i, argv: ["sh"] }));
	deep.push({ pid: 1040, ppid: 1, argv: ["agy"] });
	assert.equal(await isAttendedSession(1000, await procTree(t, deep)), undefined);
});

test("isCliTranscript accepts only a file inside the CLI's own conversation folder", async (t) => {
	const home = "/home/me";
	const cli = "/home/me/.gemini/antigravity-cli/brain/0d55435a/.system_generated/logs/transcript_full.jsonl";
	assert.equal(isCliTranscript(cli, home), true);
	for (const other of [
		"/home/me/.gemini/antigravity/brain/0d55435a/transcript_full.jsonl",
		"/home/me/.gemini/antigravity-ide/brain/0d55435a/transcript_full.jsonl",
		"/home/me/.gemini/antigravity-cli-x/brain/0d55435a/transcript_full.jsonl",
		"/home/me/.gemini/antigravity-cli/brain",
		"/home/me/.gemini/antigravity-cli/brain/../../evil/transcript_full.jsonl",
		"/home/you/.gemini/antigravity-cli/brain/0d55435a/transcript_full.jsonl",
		"antigravity-cli/brain/0d55435a/transcript_full.jsonl",
		"",
		undefined,
		42,
	]) {
		assert.equal(isCliTranscript(other, home), false, String(other));
	}
	// A relative path is read against the working directory, which must not make it a CLI path.
	const real = await tempDir(t);
	await fs.mkdir(path.join(real, ".gemini"));
	const before = process.cwd();
	process.chdir(path.join(real, ".gemini"));
	try {
		assert.equal(isCliTranscript("antigravity-cli/brain/0d55435a/transcript_full.jsonl", real), false);
	} finally {
		process.chdir(before);
	}
});
