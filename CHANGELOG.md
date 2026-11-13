# Changelog

## 0.2.0 - 2026-11-13

- auto-learn now runs in Codex. Install it with `codex plugin marketplace add Yashpal-0/auto-learn` and `codex plugin add auto-learn@auto-learn`, then trust its hooks with `/hooks`. After an eligible turn, a background fork of the session made with `codex app-server` reviews the turn and saves what it worked out as a skill in `~/.agents/skills`, the folder Codex reads personal skills from. The fork runs with the approval policy `never` and a read-only sandbox, and approves `manage_skill` alone. The README's Codex section has the details.
- Claude Code behaves as before. Codex reads its own manifest, hooks and MCP configuration from `.codex-plugin/` and `codex/`, and keeps its skills and log apart from Claude Code's.

## 0.1.2 - 2026-11-12

- At session start, and again after each compaction, the plugin lists the learned skills for Claude with a short description of each, newest first, up to 4,000 characters. Claude Code lists skills by name only once its listing outgrows its budget, starting with the skills used least, so new learned skills were the first to lose their descriptions. Skills that `skillOverrides` in the user settings hides are left out.

## 0.1.1 - 2026-11-12

- The log's `costUsd` is now what a review itself cost. Claude Code counts a resumed session's earlier cost into the total it reports for the review's fork; auto-learn now reads that cost from `~/.claude.json`, subtracts it, and logs it as `sessionCostUsd`. Entries logged by 0.1.0 overstate `costUsd` for resumed sessions.
- The README gives costs measured with Claude Opus 5.5 as well as Haiku 5.5.

## 0.1.0 - 2026-11-12

First release.

- After a turn with at least `minToolCalls` tool calls (5 by default), a background fork of the session reviews the turn and saves any procedure worth keeping as a personal skill. Only `manage_skill` runs in the fork.
- The `manage_skill` tool creates skills in `~/.claude/skills`, and updates or deletes only the skills it created.
- At session start, Claude is told about `manage_skill` and where skills are saved.
- Each queued, skipped and finished review is logged to `auto-learn.log` in the plugin's data folder, without conversation text.
