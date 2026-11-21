#!/usr/bin/env node
// Stands in for the agy process that runs a plugin's hook, for tests that need
// the hook to have an agy ancestor: a test starts this under the name agy
// (spawn's argv0) as `agy-parent.mjs [agy flags] -- <script> [arguments]`. It
// runs the script under `sh -c`, as agy runs a hook, with its own stdin as the
// hook input, relays what the script printed and exits with its status. The
// flags before `--` only go on the command line the script's ancestors can
// read, where `-p` is what a script run of agy looks like.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const command = process.argv.slice(process.argv.indexOf("--") + 1);
const quoted = [process.execPath, ...command].map((word) => `'${word}'`).join(" ");
const run = spawnSync("/bin/sh", ["-c", quoted], { input: readFileSync(0), encoding: "utf8" });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exitCode = run.status ?? 1;
