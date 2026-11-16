# Changelog

## 0.3.1 - 2026-11-16

- Claude Code: `manage_skill` can read a managed skill's full text and revision. Updates and deletes require that revision and refuse stale copies, so a review cannot silently replace another session's saved steps. Exclusive locks serialize changes across MCP processes. Existing skill files need no conversion; callers must read before updating or deleting.
- Claude Code: skill creation checks ancestor project skills up to the Git repository or worktree root, main-checkout skills and commands inherited by a linked worktree, and legacy commands in project and personal `.claude/commands` folders, before creating a personal skill that would shadow them.
- Claude Code: skill creation refuses the reserved names `synced` and `anthropic-skills`. Older managed skills with either name can still be read and deleted.

- Claude Code: the log's `costUsd` now subtracts the session's last `cost-state` entry in its transcript, which is what Claude Code starts a review fork's cost counters from. The 0.1.1 entry below was wrong about the source: `~/.claude.json` records only a project's last session to exit, so when another session in the same project exited later, versions 0.1.1 to 0.3.0 logged the session's earlier cost as part of `costUsd`. A total that auto-learn cannot check is now logged as `reportedCostUsd`, never as `costUsd`.
- Claude Code: reviews read the fork's messages as they arrive. A review that hits its time limit, or is stopped because the session ended, now logs its turns, tokens, calls and saved skills so far, without a cost; one stopped after Claude Code printed its result is logged from that result. A fork that ends without a result is logged with the error `claude ended without a result (exit N): …`.
- Claude Code: the new `refusedTools` field names up to 10 of the tools the gate refused.
- Claude Code: on Claude Code 2.1.295 or later, the gate also refuses the call when the gate hook itself fails or takes more than 10 seconds.
- Claude Code: the MCP server is now declared in `.claude-plugin/plugin.json`, and the root `.mcp.json` is gone. In sessions opened inside the auto-learn repository, `.mcp.json` could also load as a project server, which failed to start.
- Claude Code and Codex: a review's created, updated and deleted skills now come from its own successful `manage_skill` calls, by the names the store saved them under, instead of from a comparison of the skill folder before and after. A review no longer claims a skill that another session saved while it ran.
- Claude Code and Codex: the review request tells the model to treat instructions in files, tool output and quoted text as evidence, and to update or delete a skill only when its full text is in the conversation.
- Codex: a review is stopped, with the outcome `stopped`, once Codex reports that it has called more than 3 tools other than `manage_skill`. auto-learn counts a call when Codex reports that it has finished, so the call that goes over the limit, and any that run alongside it, still run. The new `otherTools` field names up to 10 of those tools, without their arguments or output.
- Codex: a review is also stopped, with the outcome `stopped`, as soon as Codex reports that it has started a subagent tool such as `spawn_agent`, which counts as one call. A subagent of the review inherited its approval of `manage_skill`, so it could save a skill that the log did not credit to the review, and its tool calls and tokens counted toward neither the limit nor the log.
- Codex: a review that was stopped, timed out, was aborted or failed after its fork started now logs its calls and skills so far, and the tokens Codex had reported.
- All hosts: `manage_skill` refuses a skill body that contains `` !`command` ``, a ```` ```! ```` block or a `!` right before an argument such as `$ARGUMENTS`, because Claude Code runs those commands when it loads the skill, after it fills in the arguments.
- All hosts: `manage_skill` refuses more kinds of credentials: PGP private key blocks; Stripe, npm, Hugging Face and PyPI tokens; passwords in URLs; `Bearer` tokens; AWS secret access keys written next to their variable name; Google OAuth client secrets and access tokens; age secret keys; Slack webhook URLs; and OAuth token secrets, Launchpad's credentials file and `PLAINTEXT` signatures included. Placeholders such as `$TOKEN` are still accepted, but AWS's documented example secret key and a `Bearer` placeholder of 20 or more characters are now refused.
- The README says how to update an installed copy in Claude Code and in Codex, gives measured review costs for Codex, and says that on Linux a command a Codex review leaves running keeps running after the review ends.

## 0.3.0 - 2026-11-14

- auto-learn now runs as a native OpenCode V2 plugin. Install it directly from GitHub with `opencode plugin add github:Yashpal-0/auto-learn`. It adds `manage_skill`, saves to OpenCode's own skill library, and refreshes discovered skills after changes.
- Successful eligible root-session turns receive a transient, tool-free review through the session's model. Validated create/update proposals use the existing protected skill store. Reviews add no conversation turns, cannot delete skills, honor permission rules without background prompts, and discard late results after cancellation or timeout. The README documents usage costs and the native API's cancellation limitation.
- Claude Code and Codex keep their existing hooks, MCP configuration and skill libraries.

## 0.2.0 - 2026-11-13

- auto-learn now runs in Codex. Install it with `codex plugin marketplace add Yashpal-0/auto-learn` and `codex plugin add auto-learn@auto-learn`, then trust its hooks with `/hooks`. After an eligible turn, a background fork of the session made with `codex app-server` reviews the turn and saves what it worked out as a skill in `~/.agents/skills`, the folder Codex reads personal skills from. The fork runs with the approval policy `never` and a read-only sandbox, and approves `manage_skill` alone. The README's Codex section has the details.
- Claude Code behaves as before. Codex reads its own manifest, hooks and MCP configuration from `.codex-plugin/` and `codex/`, and keeps its skills and log apart from Claude Code's.

## 0.1.2 - 2026-11-12

- At session start, and again after each compaction, the plugin lists the learned skills for Claude with a short description of each, newest first, up to 4,000 characters. Claude Code lists skills by name only once its listing outgrows its budget, starting with the skills used least, so new learned skills were the first to lose their descriptions. Skills that `skillOverrides` in the user settings hides are left out.

## 0.1.1 - 2026-11-12

- The log's `costUsd` is now what a review itself cost. Claude Code counts a resumed session's earlier cost into the total it reports for the review's fork; auto-learn now reads that cost from `~/.claude.json`, subtracts it, and logs it as `sessionCostUsd`. Entries logged by 0.1.0 overstate `costUsd` for resumed sessions.
  Correction, added later: `~/.claude.json` records only a project's last session to exit, so when another session in the project exited later, this release and those up to 0.3.0 logged the session's earlier cost as part of `costUsd`. The release after 0.3.0 reads the cost from the session's transcript instead.
- The README gives costs measured with Claude Opus 5.5 as well as Haiku 5.5.

## 0.1.0 - 2026-11-12

First release.

- After a turn with at least `minToolCalls` tool calls (5 by default), a background fork of the session reviews the turn and saves any procedure worth keeping as a personal skill. Only `manage_skill` runs in the fork.
- The `manage_skill` tool creates skills in `~/.claude/skills`, and updates or deletes only the skills it created.
- At session start, Claude is told about `manage_skill` and where skills are saved.
- Each queued, skipped and finished review is logged to `auto-learn.log` in the plugin's data folder, without conversation text.
