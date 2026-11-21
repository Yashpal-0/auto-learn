# Antigravity CLI (agy) Support Implementation Plan

> **For agentic workers:** Use `executing-plans` to implement this plan in the current session, task by task. Steps use checkbox (`- [ ]`) syntax. Tasks 1 to 4 are already committed; start at Task 5.

**Goal:** auto-learn works in Antigravity CLI: after an attended turn with enough tool calls, a background review saves a skill that agy offers from the next conversation on. The result is proven on the real `agy`, pushed to `origin/main`, and installed into the owner's agy from the GitHub URL.

**Architecture:** A native agy plugin at the repository root (`.antigravity-plugin/plugin.json`, `hooks.json`, `mcp_config.json`, `agents/`) beside the other hosts' files. SessionStart injects guidance and the learned-skill list. Stop reads the turn from the transcript, decides eligibility and starts the existing detached worker, which runs one fresh headless `agy -p` review, confined to `manage_skill`, in a private conversation store that is emptied after each run.

**Tech stack:** ECMAScript modules, Node 18+, zero dependencies, `node:test`; the real `agy` 1.5.14 for verification.

**Spec:** `docs/superpowers/specs/2026-11-21-agy-support-design.md` (read it first; this plan only records the decisions it leaves to the implementer).

## Global Constraints

- Node 18+, no runtime dependencies; the other five hosts behave exactly as before (their tests stay green and untouched except where a shared signature grows).
- One host id, `agy`, everywhere: `--host=agy`, `job.host`, `prompts/agy/`, `parseHost`.
- `hooks.json` registers only SessionStart (timeout 10) and Stop (timeout 30), each `node ./scripts/hook.mjs <event> --host=agy`. Never register PreToolUse (a hook that prints `{}` there is a deny). No root `plugin.json` (Copilot CLI would prefer it).
- Review command: `agy -p "" --input-format stream-json --output-format stream-json --agent auto-learn-review --print-timeout 240s --settings '{"toolPermission":"always-proceed"}' --disable-slash-commands --app_data_dir=auto-learn-review`; prompt on stdin as one NDJSON line, then stdin closed; cwd `<data dir>/review-workspace`; SIGTERM at 300 s, SIGKILL 5 s later, to the whole process group (`detached: true`, `process.kill(-pid, ...)`); stderr in a 64 KiB sink; stdout lines capped at 8 MiB.
- Excerpt limits: user 4,000, reply 2,000, call arguments 600, result 1,200, total 60,000 characters (`EXCERPT_LIMITS`). Prompt first line `[auto-learn review]`.
- Child environment drops exactly `ANTIGRAVITY_CONVERSATION_ID`, `PLUGIN_ROOT`, `PLUGIN_DATA` (plus `forkEnvironment`'s own list) and adds `AUTO_LEARN_CAPTURE=1`, `AUTO_LEARN_PROJECT_DIR`. The environment, the prompt and the excerpt never reach a log, a job file or an error message.
- Data directory for agy: `$PLUGIN_DATA`, else `~/.gemini/antigravity-cli/plugin_data/auto-learn`. Skills: `~/.gemini/config/skills`. Review store: `~/.gemini/auto-learn-review`.
- Version 0.5.0 in `package.json` and the Claude, Codex, Copilot and agy manifests. Commits: imperative subject up to 72 characters, body wrapped at 72 saying problem, why, risk; refactors apart from behavior; no attribution lines; no `--no-verify`.
- Every new test is shown to fail with its bug put back (saboteur), and a failing test is seen red before its code exists.

## Review Focus

- The review's conversation id comes from agy's stream, which carries attacker-influenced text: a crafted id must never reach a path (Task 6 test: `../`, absolute and non-UUID ids delete nothing).
- Two sessions end turns together: two workers, two reviews in one store. Each deletes only its own id and the sweep spares anything under an hour old (Task 6 test).
- The model calls a tool other than `manage_skill`, or `manage_skill` on another server: the run stops and nothing but a name is logged (Tasks 7 and 8 tests: stream and runner).
- An excerpt containing the closing marker, `</USER_REQUEST>` or request-like text cannot end its block: the markers carry a per-run random nonce absent from the excerpt (Task 8 test).
- `agy` is missing, prints non-JSON, never prints a result, hangs, ignores SIGTERM, or leaves a grandchild: each ends in a recorded outcome within the limits, with no process left (Task 8 tests with the stand-in).
- The project folder is deleted, `HOME` is unwritable or the disk is full between Stop and the worker: the record says `skipped` or `error`, the hook and agy are unaffected (Tasks 8 and 9 tests).

## Tasks done (committed)

- [x] **Task 1: shared modules know agy.** `f936f34`, `6c6f5bf` (refactors: `parseHost` error from the list, MCP context table), `6d3c4ef` (host `agy` in `config.mjs`, `state.mjs` `queued` and `pruneSessions`, `skills.mjs`, `mcp.mjs`, `prompts.mjs`, `mcp-server.mjs`, `prompts/agy/*`).
- [x] **Task 2: transcript scan and excerpt.** `4eb4ab9`: `scanTurn(file, fromOffset)`, `renderTurn(file, start, end, limits)`, `EXCERPT_LIMITS`, real fixture.
- [x] **Task 3: review request.** `92a1d15` (`learnedSkillLines`), `480897d` (skill list in `captureNudge(tool, host, values)`), `d91557c` (stop when a `create` name is taken).
- [x] **Task 4: spec and plan** (this document and the design doc, committed together).

## Task 5: who is at the keyboard (`scripts/lib/agy-session.mjs`)

**Files:** create `scripts/lib/agy-session.mjs`, `test/agy-session.test.mjs`.

**Interfaces:**
- Produces: `isCliTranscript(transcriptPath: string, home?: string): boolean` is true only for a path inside `<home>/.gemini/antigravity-cli/brain/` (`home` defaults to `os.homedir()`; `..` segments and a sibling such as `antigravity-cli-x/` are false).
- Produces: `isAttendedSession(pid?: number, procRoot?: string): Promise<boolean | undefined>` walks `procRoot/<pid>/stat` parent ids from `pid` (default `process.pid`; at most 16 levels) to the first process named `agy` (`basename(argv[0])` or the `exe` link), then reads its argv: `false` for `-p`/`--print`/`--prompt` (one or two dashes, with or without `=value`), `--hub`, `--remote-agent`, or `acp` as `argv[1]`; `true` otherwise (so `-i`/`--prompt-interactive` and a bare `agy` are attended); `undefined` when `process.platform` is not `linux` and no `procRoot` is given, no `agy` ancestor is found, or its argv is unreadable.

- [ ] **Step 1: tests with a fake `/proc` tree in a temp dir** (`<pid>/stat` as `pid (comm) S ppid ...` with a `comm` containing spaces and `)`, `<pid>/cmdline` NUL-separated, optional `<pid>/exe` symlink): TUI `node, sh, agy` is `true`; `agy -p x`, `agy --print=x`, `agy -prompt x`, `agy --hub --hub-port=1`, `agy --remote-agent`, `agy acp` are `false`; `agy -i x` and `agy --settings '{"a":"-p"}'` are `true`; `argv[0]` as an absolute path and an `exe`-only match both find agy; no agy ancestor, a missing `procRoot`, and a cycle in the parent chain give `undefined`. `isCliTranscript` cases above. Run: `node --test test/agy-session.test.mjs`; expected: fails with `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 2: implement both functions.** Parse the parent id after the last `)` of `stat`. Pure reads, no writes.
- [ ] **Step 3: run the test, then a saboteur per branch** (treat `--print` as attended; drop the depth bound; match `agy-x`): each makes a test fail.
- [ ] **Step 4: commit** "Tell an agy session at a terminal from a script run".

## Task 6: the review store (`scripts/lib/agy-store.mjs`)

**Files:** create `scripts/lib/agy-store.mjs`, `test/agy-store.test.mjs`.

**Interfaces:**
- Produces: `reviewStoreDir(home: string): string` is `<home>/.gemini/auto-learn-review`.
- Produces: `removeConversation(storeDir: string, conversationId: unknown): Promise<string | undefined>` removes `brain/<id>`, `conversations/<id>.db`, `-wal` and `-shm`, and `presence/<id>.lock` for a lowercase UUID, as agy writes it, and returns a short error text (`could not remove <relative path>: <code>`, no store location), or `undefined` when all are gone or never existed. Any other id, an uppercase one included, deletes nothing and returns `"not a conversation id"`: a visible failure beats a silent no-op.
- Produces: `sweepStore(storeDir: string, { now?: number, maxAgeMs?: number, logMaxAgeMs?: number }): Promise<string | undefined>` removes entries named by a UUID under `brain`, `conversations` and `presence` whose newest file is older than `maxAgeMs` (default one hour; a conversation stays while any one of its files is newer), and `log/cli-*.log` older than `logMaxAgeMs` (default one day). A missing store is not an error; a failure is reported and the rest still runs. `cli.log` is agy's own link to its newest log and is left alone.

- [ ] **Step 1: tests in a temp store**: a full set of files for two ids, one removed and one untouched; traversal ids (`../x`, `/etc`, `a/b`, empty, a non-string) delete nothing, including a decoy outside the store; a symlink named like an id removes the link, not its target; the sweep removes old entries and spares fresh ones and non-UUID names; a missing store returns `undefined`. Expected before code: `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 2: implement** with `fs.rm(..., { recursive: true, force: true })` on paths built from the validated id only.
- [ ] **Step 3: run, then saboteurs** (skip the UUID check; sweep ignoring age): tests fail.
- [ ] **Step 4: commit** "Empty the agy review store after each review".

## Task 7: read the review's stream (`scripts/lib/agy-stream.mjs`)

**Files:** create `scripts/lib/agy-stream.mjs`, `test/agy-stream.test.mjs`, `test/fixtures/agy-review-stream.ndjson` (the real L6 stream, prompt text replaced).

**Interfaces:**
- Produces: `MANAGE_SKILL_SERVER = "auto-learn_auto-learn"` (agy names a plugin's server `<plugin>_<server>`), `TOLERATED_TOOLS = ["list_resources", "read_resource", "manage_task"]`.
- Produces: `createStreamAnalyzer(): { accept(event: object): { stop: string } | undefined, finish(): StreamSummary }` where `StreamSummary` is `{ conversationId?: string, status?: string, error?: string, deniedActions: number, tokens?: { input: number, output: number, cacheRead: number, total: number }, saves: Array<{action, name}>, otherToolCalls: number, otherTools: string[], stoppedTool?: string }`.
  - `init` gives `conversationId`; the `result` event's `result` is a JSON string (or an object) with `conversation_id`, `status`, `error`, `denied_actions`, `usage`.
  - A tool step (`step_type: "tool"`) is judged on its first event: `call_mcp_tool` with `ServerName` equal to `MANAGE_SKILL_SERVER` and `ToolName` `manage_skill` is the review's own; a tolerated name is counted in `otherToolCalls` and ignored; anything else makes `accept` return `{ stop: "<tool name>" }` (for a foreign MCP call `"call_mcp_tool:<server>/<tool>"`), clipped to 100 characters, and sets `stoppedTool`.
  - A `manage_skill` call is a save only when its step reaches `DONE` with non-empty `tool_info.output` and no `tool_info.error`; the saved value is `requestedSave(arguments)` (`capture.mjs`), so a refused or unknown action is not one.

- [ ] **Step 1: tests**: the real fixture gives `saves` of one create, `deniedActions` 0, tokens from `result.usage`; the denied recording (`denied_actions: [{...}]`) gives `deniedActions` 1 and no save; an ERROR result keeps its `error` text, clipped to 500 characters; a `run_command` step, a foreign server and a foreign tool name each return `stop`; `manage_task` does not; an ERROR-state `manage_skill` step is no save; unknown event kinds and a `result` that is not JSON are ignored. Expected before code: `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 2: implement the analyzer** as a plain closure over a `Map` keyed by `step_index`.
- [ ] **Step 3: run, then saboteurs** (count a save on `ACTIVE`; drop the server check; tolerate every tool): tests fail.
- [ ] **Step 4: commit** "Read an agy review's stream and stop it at a foreign tool".

## Task 8: the review runner (`scripts/lib/agy.mjs`)

**Files:** create `scripts/lib/agy.mjs`, `test/fake-agy.mjs`, `test/agy-capture.test.mjs`.

**Interfaces:**
- Consumes: `scanTurn`/`renderTurn`/`EXCERPT_LIMITS` (Task 2), `captureNudge`/`learnedSkillLines` (Task 3), `reviewStoreDir`/`removeConversation`/`sweepStore` (Task 6), `createStreamAnalyzer` (Task 7), and from `capture.mjs` `forkEnvironment`, `boundedSink`, `isDirectory`, `skillChanges`; `learnedSkills` and `skillsDir(env, "agy")`; `lineSplitter` (`jsonl.mjs`); `isValidSessionId` (`state.mjs`).
- Produces: `agyReviewEnvironment(env: object, projectDir: string): object`.
- Produces: `runAgyReview({ prompt, cwd, env, signal, timeoutMs?, killGraceMs? }): Promise<{ outcome: "ok" | "error" | "timeout" | "aborted" | "stopped", reason?, error?, summary: StreamSummary }>`: spawns `agy` with the Global Constraints command, writes the NDJSON prompt line `{"event":"user","message":{"content":[{"type":"text","text":<prompt>}]}}`, parses stdout lines through the analyzer, kills the process group on timeout, abort or `stop`. `ok` needs a `result` with `status` `SUCCESS`, no denied actions and no `stop`; `denied_actions` is an `error` ("agy denied N actions"); no `result` is an `error` carrying the exit status and the last 500 characters of stderr; a missing binary is "the agy CLI was not found on PATH".
- Produces: `captureAgyTurn(job, { env?, signal? }): Promise<Record>` with `job = { host: "agy", sessionId, transcriptPath, start, end, toolCalls, projectDir }`. Returns `{ outcome: "skipped", reason }` for a malformed job, a missing transcript or a missing project folder; otherwise the runner's outcome plus `created`, `updated`, `deleted` (from `skillChanges`), `otherToolCalls`, `otherTools`, `deniedActions`, `tokens`, `stoppedTool`, `cleanupError` when cleanup failed, and `durationMs`. Order: sweep the store, render the excerpt for [start, end), list the saved skills (`"none yet"` when empty), build the prompt (`[auto-learn review]`, a blank line, `BEGIN <nonce>`, excerpt, `END <nonce>`, a blank line, `captureNudge("manage_skill", "agy", { skills })`; the nonce is 16 random hex digits), run, then `removeConversation` with the id from the stream whatever the outcome.
- `test/fake-agy.mjs` is a node script behind a `#!/bin/sh` shim on `PATH`; modes `ok` (init, a `manage_skill` create step that reaches DONE with output, a SUCCESS result; it writes no skill file, since skill writing belongs to the MCP server's own tests), `refused` (denied_actions), `exit` (no result, exit 3, stderr text), `hang` (no output until killed), `stubborn` (ignores SIGTERM and has a grandchild that records its pid), `rogue` (a `run_command` step, then it would write a marker file after one second), `polite` (SIGTERM handled). It creates `<HOME>/.gemini/<--app_data_dir value>/{brain,conversations,presence}/<id>*` like the real one, and records args, cwd, selected env and stdin to `$FAKE_AGY_RECORD`.

- [ ] **Step 1: tests (red first)**, using a `world(t, mode)` helper modeled on `test/copilot-capture.test.mjs`: the command line equals the Global Constraints one; cwd is `<data dir>/review-workspace`; stdin holds exactly one NDJSON line whose text starts `[auto-learn review]`, holds the excerpt between two marker lines whose nonce is absent from the excerpt, lists the saved skills, and ends with the request; the child environment lacks the three names, `CLAUDE_PLUGIN_OPTION_*` and the parent-session variables, and has `AUTO_LEARN_CAPTURE=1` and `AUTO_LEARN_PROJECT_DIR`; `ok` records created skills and leaves the store without that id; `refused` and `exit` are `error` with no excerpt text in the record; `hang` and `stubborn` end `timeout` within limit plus grace (with small injected limits) with the grandchild dead; `rogue` is `stopped` with `stoppedTool "run_command"` and the marker file never appears; abort gives `aborted`; ENOENT gives the PATH message; a malformed job, missing transcript and missing project folder are `skipped`; a stale orphan older than an hour is swept and a fresh one stays; a record never contains the prompt or `HOME` text. Expected before code: `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 2: write `test/fake-agy.mjs`** from the real stream recordings (shapes in the spec), then `scripts/lib/agy.mjs`, mirroring `scripts/lib/copilot.mjs` (`captureCopilotTurn`, `runCopilotFork`, `copilotForkEnvironment`).
- [ ] **Step 3: run the file, fix, run the whole suite** (`node --test test/*.test.mjs`).
- [ ] **Step 4: saboteurs** (SIGTERM only the child, not the group; skip the sweep; log the prompt; delete before parsing the id; accept `result` without `status`): each fails a test.
- [ ] **Step 5: commit** "Run an agy review of a turn, and stop it at a foreign tool".

## Task 9: hook plumbing

**Files:** modify `scripts/lib/hook.mjs`, `scripts/hook.mjs`, `scripts/capture.mjs`; create `test/agy-hook.test.mjs`; adjust `test/hook.test.mjs`/`test/capture-worker*.test.mjs` only where a signature grows.

**Interfaces:**
- Consumes: Tasks 2, 5 and 8, `readSessionState`/`writeSessionState`/`queueCapture`/`pruneSessions`/`appendLog` (`state.mjs`), `sessionContext(env, host)` and `loadOptions(env)`.
- Produces: `runHook(event, input, { env, spawnWorker, host })` accepts `host: "agy"`: the session id is `input.conversationId`, the data directory `dataDir(env, host)`; `spawnWorker` is called `spawnWorker(sessionId, env, host)` and `spawnCaptureWorker` passes `--host=<host>` for every non-Claude host and uses `dataDir(env, host)` as cwd.
- Produces: the agy SessionStart returns `{"injectSteps":[{"systemMessage":{"systemMessage": <guidance + learned skills>}}]}` for a CLI session after writing `{offset: 0, toolCalls: 0}` and `pruneSessions(dir, 30 days)`, and `undefined` for any other (the entry point prints `{}`).
- Produces: the agy Stop applies the spec's gating order (`autoCapture`, CLI session, empty `lastUserInput`, `fullyIdle === false`, `isAttendedSession`, `scanTurn` from the saved offset, `/plan`, `minToolCalls`, already queued), logs each skip as `{event: "skip", session, reason, toolCalls}`, and on a qualifying turn writes state `{offset, promptId, toolCalls, queued: true}`, queues `{host: "agy", sessionId, transcriptPath, start: offset, end, toolCalls, projectDir}` (projectDir from `workspacePaths[0]` else `cwd`), logs `{event: "queued", session, toolCalls, terminationReason}` and spawns the worker.
- Produces: `scripts/capture.mjs` parses `--host` with `parseHost(process.argv.slice(3))`, resolves `dataDir(process.env, host)`, dispatches `job.host === "agy"` to `captureAgyTurn(job, { signal })`, and does not start the session-state watcher for agy (agy has no SessionEnd).

- [ ] **Step 1: tests (red first)**, with an `agySession` helper modeled on `copilotSession` in `test/copilot-hook.test.mjs` and the `agy` builders of `test/helpers.mjs`: SessionStart output shape and state; a non-CLI transcript path prints nothing and writes no state; five tool calls queue one job with the exact fields and spawn the worker once with host `agy`; a second Stop of the same turn is skipped as `already queued`; a new user turn queues again; four calls, `/plan`, empty `lastUserInput`, `fullyIdle: false`, `AUTO_LEARN_CAPTURE` set, `autoCapture` off, an unattended session (`isAttendedSession` injected as `false`) and an unclassifiable one (`undefined`, logged "unattended session") each queue nothing; a subagent-wake sequence (Stop with `fullyIdle: false`, Stop with empty input, Stop with both set) queues once at the third; a corrupt state file recovers with a scan from the start; the entry point prints `{}` for no-ops and, on a thrown error, writes to stderr and exits 1 without stdout; the worker dispatch calls `captureAgyTurn` for an agy job and never starts the watcher.
- [ ] **Step 2: implement.** `isAttendedSession` is injected through `runHook`'s options (like `spawnWorker`) so tests need no `/proc`.
- [ ] **Step 3: run the new file, then the whole suite**; the five other hosts' tests stay green.
- [ ] **Step 4: saboteurs** (queue before the dedupe check; skip the `fullyIdle` test; drop `--host`): tests fail.
- [ ] **Step 5: commit** "Start an agy review at the end of a worked turn".

## Task 10: native files, manifests, docs

**Files:** create `.antigravity-plugin/plugin.json`, `hooks.json`, `mcp_config.json`, `agents/auto-learn-review.md`; modify `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, the Copilot manifest, `marketplace.json` descriptions, `README.md`, `CHANGELOG.md`, `test/manifest.test.mjs`.

**Interfaces:** `.antigravity-plugin/plugin.json` holds only known fields (name `auto-learn`, description, displayName, version `0.5.0`, author, homepage, repository). `mcp_config.json` is `{"mcpServers":{"auto-learn":{"command":"node","args":["${PLUGIN_ROOT}/scripts/mcp-server.mjs","--host=agy"],"tools":{"manage_skill":{"eager":true}}}}}`. The agent file has frontmatter `name: auto-learn-review`, `description` saying it is internal and not for delegation, `mainAgent: true`, `subagent: false`, `tools: []`, `inheritMcp: false`, and a body telling the model to call `manage_skill` through `call_mcp_tool`.

- [ ] **Step 1: manifest tests (red first)**: the four native files exist and parse; `hooks.json` has exactly SessionStart and Stop with the timeouts and commands above and no PreToolUse; no root `plugin.json`; every manifest and `package.json` share one version; the agent file has the five frontmatter fields; `prompts/agy/` holds the four prompts.
- [ ] **Step 2: write the files and bump the versions.** README section "Antigravity CLI": install, update and uninstall with `agy plugin ...`, the two env options exported before starting agy, that each eligible turn uses quota and sends its excerpt to the model provider, shared use with the Antigravity IDE, the `~/.gemini/auto-learn-review` store and the extra subagent, and what is untested. CHANGELOG 0.5.0.
- [ ] **Step 3: run** `node --test test/*.test.mjs`, `agy plugin validate .` (only the Claude `hooks/hooks.json` "never loaded" note is accepted) and `claude plugin validate .`; load-check Copilot CLI and Codex with the new root files (spec verification 5).
- [ ] **Step 4: commit** the files (one commit) and the docs (one commit): "Add the agy plugin files" and "Document the agy host and release 0.5.0".

## Task 11: verify and ship

- [ ] **Step 1: whole suite and a mutation pass** on the new tests (`mutation-check-new-tests`): no surviving mutant left unexplained.
- [ ] **Step 2: real agy, throwaway home** from a clean `git archive` export of the head commit (spec verification 3): no sign-in step is needed (`HOME=<empty folder> agy models` lists models), at most 8 real-model turns, pty-driven TUI turn with at least 5 tool calls, review saves a skill, the next conversation lists it; also `-p`, `/plan`, a short turn and an IDE-style path start nothing; review store and CLI store hold no conversation afterwards, and a search of the review store for text of the excerpt finds none; `agy --version` and the binary's modification time are unchanged; measure the `agy` process name in `/proc`, the MCP server's working directory and the hook's environment; measure the size growth of `conversation_summaries.db` per review.
- [ ] **Step 3: adversarial review** by a small workflow (under five agents) over the diff since `d91557c`, plus a fix of everything confirmed; re-run Steps 1 and 2 where code changed.
- [ ] **Step 4: ship**: `git push origin main` (fast-forward only), then in a throwaway home `agy plugin install https://github.com/Yashpal-0/auto-learn` (native format, hooks, MCP server and agent loaded, one real review saves a skill), then the same command in the owner's real home, checked with `agy plugin list` and `agy agents`.
- [ ] **Step 5: housekeeping**: update the learned skill `agy-plugin-hooks-contract` with the verified facts, delete the scratch probe folders, and report what stayed untested.
