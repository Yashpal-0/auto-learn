# OpenCode Support Implementation Plan

> **For agentic workers:** Use `executing-plans` to implement this plan in the current session.

**Goal:** Add native OpenCode V2 support, push the verified update to GitHub, and install it globally from that repository.

**Architecture:** A dependency-free package exports an OpenCode `id`/`setup` plugin. It reuses the existing skill store and prompts. Successful root-session turns trigger transient, tool-free session generation; validated proposals go through the same skill store as manual saves.

**Tech stack:** ECMAScript modules, Node.js 18+, OpenCode V2's native plugin API, `node:test`.

**Approved spec:** The user approved native background reviews and `manage_skill`, a separate OpenCode skill library, unchanged Claude/Codex support, and committing/pushing `origin/main` before installing from GitHub. Reviews consume additional model tokens.

## Global constraints

- Keep `autoCapture: true` and `minToolCalls: 5` as the defaults.
- Add no runtime dependencies; preserve the existing Claude/Codex entrypoints.
- Save OpenCode skills under `$XDG_CONFIG_HOME/opencode/skills`, or `~/.config/opencode/skills`; retain `AUTO_LEARN_SKILLS_DIR` for testing.
- Never overwrite another discovered skill, follow a managed-skill symlink, or save detected credentials.
- Reviews execute no tools, create no conversation turns, and cannot apply results after cancellation or unload.
- Use one bounded review per session; log skipped, completed, aborted, and failed reviews without conversation text.
- No force push, npm publication, unrelated configuration changes, or edits to OpenCode itself.

## Review focus

- A new prompt races with a review: discard the stale proposal before writing.
- Events reach several location-scoped plugin instances: only the owning instance reviews the session.
- Skills come from compatibility, ancestor, flat-file, or configured sources: check OpenCode's full catalog before creating.
- The model emits malformed JSON or a destructive proposal: reject it without logging its contents.
- A request outlives timeout/unload: ignore its result and document any native cancellation limitation.

## Task 1: Shared OpenCode skill support

**Files:** `scripts/lib/config.mjs`, `scripts/lib/skills.mjs`, `scripts/lib/prompts.mjs`, `scripts/lib/mcp.mjs`, `prompts/opencode/`, and their existing tests.

**Interfaces:** Extend `skillsDir(env, host)` and prompt host selection with `opencode`; export the existing tool input schema for native registration. Claude/Codex outputs stay unchanged.

- [x] Add failing tests for the XDG skill directory, OpenCode project collisions, and OpenCode prompt rendering.
- [x] Run those tests and confirm feature-specific failures.
- [x] Implement the host additions and shared schema export.
- [x] Run the targeted tests and check the existing hosts still pass.

## Task 2: Native plugin and reviews

**Files:** `opencode/index.mjs`, `opencode/capture.mjs`, `test/opencode.test.mjs`, `test/opencode-capture.test.mjs`.

**Interfaces:** Export a default `{ id: "auto-learn", setup }` plugin. Register `manage_skill` in the `auto_learn` namespace, inject guidance into session context, refresh skills after saves, and subscribe to successful execution events. Reviews accept `null` or one `create`/`update` proposal.

- [x] Add failing tests for manual saves, catalog collision protection, permissions, and live skill refresh.
- [x] Implement the smallest native tool and guidance integration; run the tests.
- [x] Add failing tests for successful-turn selection, threshold, plan/child/location exclusion, deduplication, and tool-free review output.
- [x] Implement background reviews with timeout, cancellation, bounded concurrency, and metadata-only logging.
- [x] Add race/error tests for a new prompt, deletion/unload, malformed output, secrets, and denied writes; run the targeted suite.

## Task 3: Package and delivery

**Files:** `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `README.md`, `CHANGELOG.md`, `test/manifest.test.mjs`.

- [x] Add package/export tests, bump the release to `0.3.0`, and document OpenCode installation, options, review behavior, cost, privacy, and limits.
- [x] Run `node --test test/*.test.mjs` and inspect `npm pack --dry-run`.
- [x] Exercise the packaged plugin in an isolated real OpenCode server using a local deterministic provider; inspect the written skill and review log.
- [ ] Review the complete diff, then commit and push to `origin/main` without rewriting history.
- [ ] Run `opencode plugin add github:Yashpal-0/auto-learn`; verify the installed revision, active plugin, and registered tool.
