// Tells a Stop hook which Antigravity CLI session it belongs to and whether a
// person is at the keyboard. The hook payload says neither, so this reads the
// conversation's path and the hook's own ancestry (checked with agy 1.5.14:
// the hook runs as node, under `sh -c`, under the `agy` process).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_ANCESTORS = 16;
/** Flags that make agy run one prompt without a person, or serve something else: -p, --print and --prompt (Go accepts one or two dashes and `=value`), the IDE's --hub, --remote-agent. */
const SCRIPT_FLAGS = new Set(["p", "print", "prompt", "hub", "remote-agent"]);

/** Whether `transcriptPath` is a conversation of the CLI. The IDE and the 2.0 app keep theirs in sibling folders and are not reviewed. */
export function isCliTranscript(transcriptPath, home = os.homedir()) {
	if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return false;
	const brain = path.join(home, ".gemini", "antigravity-cli", "brain") + path.sep;
	return path.resolve(transcriptPath).startsWith(brain);
}

/**
 * Whether a person is at a terminal with the agy that runs this process:
 * true for a plain `agy` or `agy -i`, false for a script run (`-p`, `--print`,
 * `--prompt`), `agy acp`, `--hub` and `--remote-agent`, and undefined when no
 * agy ancestor can be read, as on a system without /proc (macOS, Windows).
 *
 * @param {number} pid the process whose ancestors are searched, by default this one
 * @param {string} procRoot where /proc is
 * @returns {Promise<boolean | undefined>}
 */
export async function isAttendedSession(pid = process.pid, procRoot = "/proc") {
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		const found = await readProcess(procRoot, pid);
		if (!found) return undefined;
		if (found.isAgy) return found.argv ? !isScriptRun(found.argv.slice(1)) : undefined;
		pid = found.parent;
	}
	return undefined;
}

/** The parent, command line and whether it is agy, of one process; undefined when its stat cannot be read. */
async function readProcess(procRoot, pid) {
	const folder = path.join(procRoot, String(pid));
	let stat;
	try {
		stat = await fs.readFile(path.join(folder, "stat"), "utf8");
	} catch {
		return undefined;
	}
	// The name in parentheses may hold spaces and parentheses, so the fields start after the last one.
	const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
	if (!Number.isSafeInteger(parent)) return undefined;
	const argv = await fs.readFile(path.join(folder, "cmdline"), "utf8").then(
		(text) => text.split("\0").slice(0, text.endsWith("\0") ? -1 : undefined),
		() => undefined,
	);
	const executable = await fs.readlink(path.join(folder, "exe")).then(
		// agy updates itself, and a process started before the update names its old file "(deleted)".
		(target) => target.replace(/ \(deleted\)$/, ""),
		() => undefined,
	);
	const isAgy = [argv?.[0], executable].some((name) => name !== undefined && path.basename(name) === "agy");
	return { parent, argv, isAgy };
}

function isScriptRun(args) {
	if (args[0] === "acp") return true;
	return args.some((arg) => {
		const flag = /^--?([^=]+)(?:=|$)/.exec(arg)?.[1];
		return flag !== undefined && SCRIPT_FLAGS.has(flag);
	});
}
