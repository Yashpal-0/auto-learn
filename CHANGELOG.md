# Changelog

## 0.5.5 - 2026-11-28

- Antigravity CLI: `manage_skill` now supports `read`, SHA-256 `revision` checks on `update` and `delete`, and exclusive per-skill locks across MCP processes, matching Claude Code. Background reviews can now read an existing learned skill in full and update or delete it safely instead of skipping skills whose text was absent or clipped in the turn excerpt.
- Antigravity CLI: the `Stop` hook now skips `/goal` turns (`goal mode`), turns canceled by the user (`USER_CANCELED`, logged as `canceled`) and turns terminated by an error (`ERROR`, logged as `error`).
- Antigravity CLI: `create` now also checks `~/.agents/skills`, `~/.gemini/antigravity-cli/skills` and `~/.gemini/skills` (by folder name and declared frontmatter `name:`) alongside `<project>/.agents/skills` and built-in skills, so a learned skill does not collide with or get shadowed by skills Antigravity loads from those folders.
- Antigravity CLI: guidance, tool descriptions and docs now reflect that Antigravity rereads skills before each turn (so a saved skill applies on the next turn in the same session as well as in later conversations), and the learned-skills message instructs the model to read matching skills before proceeding.
- Claude Code, Codex, GitHub Copilot and OpenCode behave as before.

## 0.5.4 - 2026-11-26

- OpenCode: the learned-skills list in the session guidance is built once per session and again after each compaction, not on every request. It sits in the cached system prompt, so each saved or updated skill changed it and made every open session re-bill its whole history at uncached rates on the next request. A skill saved mid-session is now listed after that session's next compaction, or in a new session.

## 0.5.3 - 2026-11-26

- All hosts: `manage_skill` also refuses shell-execution syntax that an argument placeholder leads into (`` $ARGUMENTS!`cmd` ``, a fence line ```` ```$1! ````), because Claude Code fills the placeholders in first, and a body that `@`-mentions a file outside the project (an absolute, `~`, quoted or `..` path), which Claude Code attaches when the skill loads. The `@` check rests on a reading of Claude Code's code, not on a live run; plain relative `@path` mentions and `@` inside words stay allowed.
- All hosts: the credential check covers the description as well as the body, so a double-quoted secret in a description is no longer hidden by the file's JSON escaping. It also refuses a URL password that only contains `$` or braces (`app:Xy7$A1b2c3@db`), a URL whose user holds an `@`, lowercase `bearer` tokens that hold a digit, Slack `xapp-` tokens, and `oauth_token_secret` written with spaces, a colon or quotes. A URL password with text before its placeholder, such as `user:ghp_${TOKEN}@host`, is now refused too; only a password that starts with `$`, `{` or `<` counts as a placeholder.
- All hosts: `delete` leaves a skill folder alone when it holds files besides `SKILL.md` and the marker, and when its `SKILL.md` is a symbolic link, is not a regular file or has other hard links, as `update` already did. A managed folder whose `SKILL.md` is missing can still be deleted.
- All hosts: three hyphens in a row in a description are cut to two, since Claude Code ends a skill's frontmatter at the first `---`.
- All hosts: a learned skill whose `SKILL.md` cannot be read is left out of the guidance list instead of failing the whole listing.
- OpenCode: an approval prompt that nobody answers no longer holds up the other skill saves, or the plugin's unload, queued behind it. The prompt now waits outside the queue of writes, and a save approved after the plugin unloaded changes nothing.
- OpenCode: a turn's tool calls from before an automatic compaction now count toward `minToolCalls`. OpenCode's session context starts at the compaction, so a turn of 30 calls, a compaction and 2 more calls was skipped as having too few tool calls and never reviewed. The plugin now also counts the turn's `session.tool.success` and `session.tool.failed` events, a Code Mode call as the calls its script made, and uses the larger number.
- OpenCode: a turn that auto-compacted is reviewed even when a synthetic wake-up, not a prompt, started it, because the compaction hides what started the turn. The README says so, and that a review logged as `aborted` or `timeout` may still have saved its skill.
- Node 24 splits a line at U+2028 and U+2029, which JSON leaves unescaped inside a string. The MCP server and the Codex review reader read their input without that split, so a skill save whose text holds one of them is no longer lost with its call left unanswered. A last request without a trailing newline is still answered.
- Claude Code: a `settings.json` that exists but cannot be read, for example a directory or a file without read permission, no longer stops the SessionStart hook from adding the guidance.
- `test/opencode-live.mjs` makes its temporary folder under the system temp folder, instead of `/tmp/opencode`, which it crashed without.

## 0.5.2 - 2026-11-26

- OpenCode: with `OPENCODE_CONFIG_DIR` set, skills now go to `$OPENCODE_CONFIG_DIR/skills`. OpenCode then reads that folder in place of `~/.config/opencode/skills`, so the skills auto-learn saved there were not offered. Skills an earlier version saved there stay where they are; move their folders to `$OPENCODE_CONFIG_DIR/skills` to use them.
- Claude Code, Codex, GitHub Copilot and Antigravity CLI behave as before.

## 0.5.1 - 2026-11-23

- OpenCode: Code Mode `execute` parts now count their nested `state.metadata.toolCalls` toward `minToolCalls`, falling back to `1` when a script invoked no inner tools.
- OpenCode: turns that auto-compacted mid-flight remain eligible for review instead of being skipped as having no user prompt, while manual `/compact` runs and synthetic-only turns stay skipped.
- OpenCode: session guidance and the learned-skills listing now attach on `compaction` and `generate` as well as `context` so reviews see managed skills, keep the session's system-prompt prefix, resolve symlinked skill folders, and survive transient catalog errors.
- OpenCode: transient reviews no longer force `maxTokens: 8192` (which broke extended-thinking budgets, high-reasoning models and 4k-output models) and accept single Markdown code fences around JSON replies.
- OpenCode: `manage_skill` validates `action` and `name` before asserting permissions and passes `save: ["*"]` so choosing **Allow always** in OpenCode stores the project approval pattern.

## 0.5.0 - 2026-11-22

- auto-learn now runs in Antigravity CLI, the `agy` command. Install it with `agy plugin install https://github.com/Yashpal-0/auto-learn`. agy reads the new `.antigravity-plugin/plugin.json`, `hooks.json`, `mcp_config.json` and `agents/auto-learn-review.md`, and saves skills to `~/.gemini/config/skills`.
- In agy, a turn with enough tool calls, in a terminal session of `agy`, is reviewed by a background `agy -p` run of the new `auto-learn-review` agent, in a conversation store of its own, `~/.gemini/auto-learn-review`. The excerpt of the turn goes in on stdin. The conversation is deleted when the review ends; agy keeps a one-line summary of it, the fixed first line of the request and the review's workspace path, in the review store.
- agy: a review is stopped, with the outcome `stopped`, as soon as agy reports a call of any tool but `manage_skill`, and at its first event if agy runs it under another agent than `auto-learn-review`. That call may already have started, because agy lists its whole tool registry to the review, which runs with the permission mode `always-proceed`; the agent file's empty tool list does not limit it. The README says so under Limitations.
- agy: turns of `agy -p`, `agy acp`, `--hub` and `--remote-agent`, conversations of the Antigravity IDE and app, and prompts typed as `/plan` are not reviewed. The Stop hook tells them apart from the process that runs it, which it reads from `/proc`, so automatic reviews work on Linux only. A session started with `agy --mode plan` is reviewed like any other.
- agy: a `manage_skill` call counts as a save only when agy reports it done without an error and a line of its output begins with the message `manage_skill` prints for that action and skill. The worker ends everything its review started when the review ends, also when the review ends by itself.
- agy: the `error` that the log keeps for a review that failed has each link cut down to its host and path, because agy's account-verification message holds a sign-in link with a token in its query.
- agy: `manage_skill` has no `read` action, no revision check and no lock. `create` refuses a name that a skill in `~/.gemini/config/skills` or among agy's built-in skills already uses and, in a review, a name used in the project's `.agents/skills`.
- agy: the options are the environment variables `CLAUDE_PLUGIN_OPTION_AUTOCAPTURE` and `CLAUDE_PLUGIN_OPTION_MINTOOLCALLS`, set before `agy` starts. The log is `~/.gemini/antigravity-cli/plugin_data/auto-learn/auto-learn.log`.
- The plugin's review agent is listed by Claude Code, as `auto-learn:auto-learn-review`, and by Copilot CLI, which warns that it ignores some of the agent's fields. Its description says it is internal and not for delegation.
- The capture worker is now started with `--host=codex` and `--host=copilot` as well as `--host=agy`; Claude Code's takes no argument.
- Claude Code, Codex, GitHub Copilot and OpenCode behave as before.

## 0.4.0 - 2026-11-20

- auto-learn now runs in GitHub Copilot CLI and in Copilot Chat on VS Code's Copilot agent host. Install it with `copilot plugin marketplace add Yashpal-0/auto-learn` and `copilot plugin install auto-learn@auto-learn`. Copilot reads the new `.github/plugin/plugin.json`, with its own hooks and MCP server, and saves skills to `~/.copilot/skills`.
- In Copilot, a turn with enough tool calls, in the interactive mode, in a VS Code chat or Copilot CLI's interactive interface, is reviewed in a copy of the session through `copilot -p`, where `manage_skill` is the only tool the model can see. The copy is deleted through `copilot --headless` afterwards; the session itself is only read. The log records the review's AI credits and tokens.
- Copilot: a turn in VS Code's Auto mode, where Copilot writes the turn's tool calls to the session only after the stop hook ran, is reviewed once Copilot has committed it. A turn that another plugin's stop hook asks Copilot to continue is reviewed at its last stop, with the tool calls of its stops added up; a turn Copilot interrupts is not reviewed.
- Copilot: `manage_skill` refuses to create a skill whose name a skill in `~/.copilot/skills`, in `~/.agents/skills`, which Copilot also reads, or in the session folder's `.github/skills` already uses. It does not check the project's `.agents/skills` and `.claude/skills`. It cannot read, revision-check or lock a skill, so an update or delete applies to the skill as it is on disk, without checking whether it changed since the model read it.
- Copilot does not pass `COPILOT_PROVIDER_*` or `COPILOT_OFFLINE` to hooks, so a session on your own model provider is reviewed on your Copilot sign-in. The README's Privacy section says so.
- Claude Code, Codex and OpenCode behave as before.

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
