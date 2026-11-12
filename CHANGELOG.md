# Changelog

## 0.1.1 - 2026-11-12

- The log's `costUsd` is now what a review itself cost. Claude Code counts a resumed session's earlier cost into the total it reports for the review's fork; auto-learn now reads that cost from `~/.claude.json`, subtracts it, and logs it as `sessionCostUsd`. Entries logged by 0.1.0 overstate `costUsd` for resumed sessions.
- The README gives costs measured with Claude Opus 5.5 as well as Haiku 5.5.

## 0.1.0 - 2026-11-12

First release.

- After a turn with at least `minToolCalls` tool calls (5 by default), a background fork of the session reviews the turn and saves any procedure worth keeping as a personal skill. Only `manage_skill` runs in the fork.
- The `manage_skill` tool creates skills in `~/.claude/skills`, and updates or deletes only the skills it created.
- At session start, Claude is told about `manage_skill` and where skills are saved.
- Each queued, skipped and finished review is logged to `auto-learn.log` in the plugin's data folder, without conversation text.
