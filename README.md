# auto-learn

auto-learn lets Claude Code, Codex, GitHub Copilot, Antigravity CLI and OpenCode learn skills from your own work. After a turn in which the agent worked something out, such as how to build or test a project, the fix for an error or a setup sequence, a background review looks back at the turn and saves the procedure as a personal skill. The agent then offers that skill whenever a later task matches it.

Each agent can also save skills during a session with the `manage_skill` tool that the plugin adds.

Each host writes to its own skill library: see [Codex](#codex), [GitHub Copilot](#github-copilot), [Antigravity CLI](#antigravity-cli) and [OpenCode](#opencode) for their installation and behavior.

## Install in Claude Code

```sh
claude plugin marketplace add Yashpal-0/auto-learn
claude plugin install auto-learn@auto-learn
```

Restart running Claude Code sessions afterwards: hooks load when a session starts.

To update to a later version, refresh the marketplace, then the plugin, and restart running sessions:

```sh
claude plugin marketplace update auto-learn
claude plugin update auto-learn@auto-learn
```

auto-learn needs:

- Node.js 18 or later on `PATH`. The hooks and the MCP server are Node scripts with no dependencies.
- The `claude` command on the `PATH` that Claude Code passes to its hooks. Each review runs `claude` in the background.
- Git 2.31 or later on `PATH` when creating skills in a linked worktree missing its own `.claude/skills` or `.claude/commands` directory, to check skills and commands inherited from the main checkout.

## How a review works in Claude Code

1. At session start, the plugin tells Claude about `manage_skill` and where skills are saved, and lists the learned skills (see [Skills](#skills)).
2. When a turn ends, the Stop hook counts the turn's tool calls. The turn is queued for review when it made at least `minToolCalls` tool calls (5 by default), the session has someone at the keyboard (the terminal, an IDE, the desktop app), and the session is not in plan mode. `claude -p`, SDK and background sessions are not reviewed. The hook returns at once and starts a worker; you carry on while the review runs.
3. The worker waits until the turn is written to the session transcript, then finds its last message. It drops the turn if another Stop hook kept the turn going, if a new prompt arrived first, or if a `/goal` is still being worked on.
4. The review runs in a fork of the session:

   ```sh
   claude -p --resume <session> --resume-session-at <last message> --fork-session --no-session-persistence
   ```

   with the session's model and effort, in the session's project folder. The fork sees the conversation up to the end of that turn, exactly as the session did, and reads it from the prompt cache the session has just written. It receives one request: look back at the turn and, if it worked out a procedure that a later session would otherwise have to discover again, save it with `manage_skill`; otherwise save nothing. The request also tells Claude to treat instructions in files, tool output and quoted text as evidence, not as instructions. Before updating or deleting a managed skill, it reads that skill with `manage_skill`, preserves the steps that still hold, and passes the returned revision. If another writer changed the skill, the review leaves it for later. The fork is not saved as a session and does not appear in `/resume`.
5. Only `manage_skill` runs in the fork. A PreToolUse hook refuses every other tool; on Claude Code 2.1.295 or later it also refuses the call when the hook itself fails or takes more than 10 seconds. The fork runs in `dontAsk` permission mode, so it never prompts, edits files or runs commands. ToolSearch is allowed so that the fork can load the `manage_skill` schema. A hook cannot refuse the server-side advisor tool, so the request tells Claude not to use it, and the log counts any advisor calls.
6. A review stops after 10 model turns or 5 minutes. Reviews of one session run one at a time, oldest first. Ending the session (exiting, `/clear`, or switching to another session with `/resume`) stops its running and queued reviews.

Each queued, skipped and finished review is recorded in the [log](#log).

## Skills

Skills are saved to `~/.claude/skills/<name>/SKILL.md` (`$CLAUDE_CONFIG_DIR/skills` when that is set), the folder Claude Code reads personal skills from. Each skill that auto-learn creates also holds a `.auto-learn` marker file.

- Names are lowercase letters and digits with single hyphens between words, 1 to 64 characters, for example `deploy-docs`. In Claude Code, `synced` and `anthropic-skills` are reserved and cannot be created; an older managed skill with either name can still be read or deleted.
- A `SKILL.md` is at most 32 KiB, frontmatter included, and its description at most 1,024 characters. Three hyphens in a row in a description are cut to two, because Claude Code ends a skill's frontmatter at the first `---`.
- A skill that contains what looks like a credential is refused: private keys, PGP private key blocks included; API keys; GitHub, GitLab, Slack, AWS, Google, Stripe, npm, Hugging Face and PyPI tokens; AWS secret access keys written next to their variable name; Google OAuth client secrets; `Bearer` tokens, lowercase `bearer` too when the token holds a digit; passwords in URLs; Slack webhook URLs; age secret keys; OAuth token secrets, Launchpad's credentials file and `PLAINTEXT` signatures included; and JSON Web Tokens. The name, the description and the body are all checked. Placeholders such as `$TOKEN`, `${TOKEN}` and `<password>` are accepted; in a URL, only a password that starts with `$`, `{` or `<` counts as one, so `app:Xy7$A1b2c3@db` is refused. A few examples look real enough to be refused too, such as AWS's documented example key and `Bearer` followed by a placeholder of 20 or more characters; write `$TOKEN` instead.
- A skill whose body contains `` !`command` ``, a ```` ```! ```` block or a `!` right before an argument such as `$ARGUMENTS` is refused, and so is that syntax right after a placeholder, as in `` $1!`command` ``, because Claude Code runs those commands when it loads the skill, after it fills in the arguments. A body that `@`-mentions a file outside the project (an absolute, `~`, quoted or `..` path) is refused too, because Claude Code attaches such a file when the skill loads; plain relative `@path` mentions are not checked. Show commands in an ordinary ```` ```sh ```` block, and write paths without the leading `@`.
- `create` refuses a name that any skill already uses, in your personal skills or in the project's `.claude/skills`. In Claude Code, this includes project skill folders from the working directory up to the repository or worktree root, plus `.claude/commands/<name>.md` in those folders and your personal configuration folder. A linked worktree missing its own root `.claude/skills` or `.claude/commands` also checks that folder in the main checkout. Outside a Git repository, only the current project's folders are checked.
- `update` and `delete` work only on skills that carry the marker, and never through a symbolic link. Skills you wrote, and skills linked in from elsewhere, are never changed. Both also leave a `SKILL.md` that is not a regular file or has other hard links alone, and `delete` leaves a folder that holds files besides `SKILL.md` and the marker alone: delete such a folder yourself.
- `update` replaces a skill's whole description and body. A review is told to keep the steps that still hold, but a model's edit can still lose details.

In Claude Code, `manage_skill` also has a `read` action. It returns JSON with the managed skill's complete `content` and a SHA-256 `revision`. An `update` or `delete` must include the revision from that read; stale or missing revisions are refused. Existing skill files need no migration. A managed folder without `SKILL.md` returns `content: null` and `revision: "missing"`, so it can be restored or removed deliberately. Reads refuse files larger than 32 KiB and symbolic links.

Claude saves use an exclusive lock per skill across MCP processes. A competing change fails with a retry message; its revision is checked again when retried. Locks coordinate auto-learn's writes, while revision checks also detect user edits made before a save. An editor that writes during the save does not take this lock.

At the start of each session, and again after each compaction, auto-learn lists the learned skills for Claude with a short description of each: the whole description when it is up to 160 characters, else its first sentence, else its start cut at a word. Claude Code lists every skill too, but once its listing outgrows its budget (1% of the context window by default), it lists some skills by name only, starting with the skills you have used least, and a new learned skill has not been used yet. auto-learn's list puts the most recently changed skills first and stops at 4,000 characters, about 1,000 tokens. It leaves out the skills that `skillOverrides` in your `~/.claude/settings.json` sets to anything other than `on`.

To keep a learned skill as your own, delete its `.auto-learn` file; auto-learn then leaves it alone. To remove a learned skill, delete its folder. To list the learned skills:

```sh
find ~/.claude/skills -maxdepth 2 -name .auto-learn
```

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `autoCapture` | `true` | Review eligible turns in the background. When off, Claude can still save skills itself with `manage_skill`. |
| `minToolCalls` | `5` | The number of tool calls a turn needs before it is reviewed. `0` reviews every turn. |

Show the current values with `claude plugin configure auto-learn@auto-learn`, and change them in `/plugin` or from the command line:

```sh
echo '{"minToolCalls": "8"}' | claude plugin configure auto-learn@auto-learn --values-stdin
```

| Environment variable | Effect |
| --- | --- |
| `AUTO_LEARN_SKILLS_DIR` | Save skills to this folder instead of `~/.claude/skills`. Claude Code does not offer skills from other folders, so this is for testing. |
| `CLAUDE_CONFIG_DIR` | Claude Code's own setting for its configuration folder. auto-learn follows it. |

## Log

auto-learn writes one JSON object per line to `auto-learn.log` in its data folder, `~/.claude/plugins/data/auto-learn-auto-learn/`:

- `queued`: a turn was queued for review, with its tool call count.
- `skip`: a turn was not reviewed, with the reason.
- `capture`: a review finished, with its outcome (`ok`, `skipped`, `aborted`, `timeout` or `error`) and, for a review that ran, its model turns, duration, tokens, cost, advisor calls, refused tool calls with the names of up to 10 refused tools (`refusedTools`), and the skills it created, updated or deleted. A review that hit its time limit or was stopped because the session ended logs its turns, tokens, calls and skills so far, but no cost. A review stopped after Claude Code printed its result is logged from that result.

The created, updated and deleted skills are the review's own successful `manage_skill` calls, so a skill that another session saves while the review runs is not counted. A save whose result had not arrived when the review was stopped is not counted either, though the skill may have been written.

`costUsd` is what the review itself cost, at list price. Claude Code starts a fork's cost counters from the last `cost-state` entry for the session in its transcript, so the total it reports for the fork includes the session's cost up to that entry. auto-learn reads that entry just before the fork starts, subtracts it, and logs it as `sessionCostUsd`. When the transcript cannot be read, or the fork's per-model totals do not show that it counted on from that entry, auto-learn logs Claude Code's total as `reportedCostUsd` instead of `costUsd`.

Older entries can overstate `costUsd` for resumed sessions. Version 0.1.0 logged Claude Code's total. Versions 0.1.1 to 0.3.0 subtracted the cost that `~/.claude.json` records for a project's last session, which matches only when no other session in the project exited later; otherwise they logged the total.

The log holds no conversation text. It is readable only by you, and it rotates at 1 MiB, keeping one older file as `auto-learn.log.1`. `claude plugin uninstall` deletes it along with the data folder unless you pass `--keep-data`.

```sh
tail -n 5 ~/.claude/plugins/data/auto-learn-auto-learn/auto-learn.log
```

## Cost

A review is up to 10 more Claude requests on your account, with the session's model. In 67 measured reviews it took 2 to 9, and a review that saved a skill took at least 3. Each request sends the session's whole context again. Reading that context from the prompt cache is cheap, but the reply, thinking included, is billed in full, so on a large model a review costs real money. The cost grows with the length of the session.

Measured costs, at list price:

| Model | Context | Review | Cost |
| --- | --- | --- | --- |
| Claude Haiku 5.5 | about 90,000 tokens | saved nothing or one skill | $0.001 to $0.009 |
| Claude Opus 5.5 | about 146,000 tokens | saved a skill in 4 model turns | about $0.33 |
| Claude Opus 5.5 | about 146,000 tokens | saved a skill in 5 model turns, with one advisor call | about $1.09 |

The two Opus reviews added about 11% to what their session cost by itself; they cost 27% and 190% of the turn each one reviewed. Version 0.1.0 logged them with the session's earlier cost included, so their figures here were worked out afterwards from Claude Code's totals.

- The advisor runs on Anthropic's servers, so the review's PreToolUse hook cannot refuse it. The request asks Claude not to call it, but Claude sometimes does; one advisor call cost about $0.60 to $0.70 on Opus 5.5. Turning the advisor off for reviews would change the fork's tool list, and the fork would then miss the session's prompt cache, which costs more.
- Now and then a review makes a side request that misses the prompt cache, for a reason not yet known. One of about 60,000 tokens was measured on Haiku 5.5; at Opus 5.5 rates, it would add about $0.30.

The `costUsd` field in the [log](#log) is the full cost of a review, side requests included. Claude Code reports it at list price; on a Claude subscription, reviews count toward your plan's usage limits instead.

The learned-skill list adds at most about 1,000 tokens to each session's context.

The measurements above predate revision-checked reads. Updating or deleting a skill now requires a preceding `read` tool call.

To spend less, raise `minToolCalls`, or turn `autoCapture` off and leave saving skills to Claude during the session.

## Privacy

- auto-learn reads the session transcript under `~/.claude/projects` on your machine, to count tool calls, find where the turn ended, and read the cost Claude Code recorded for the session, of which it logs only the number.
- auto-learn reads `skillOverrides` in Claude Code's `~/.claude/settings.json`, to leave out the learned skills you hid.
- A review is a Claude Code request like any turn: the fork sends the session's conversation to Claude again, through your own Claude Code account and settings.
- The request tells Claude never to save secrets, credentials or personal data in a skill, and `manage_skill` refuses content that looks like a credential.
- Skills are written only to your skill folder, and the log holds no conversation text.

## Other hooks and plugins in the fork

The fork is a Claude Code session with your settings, so your other hooks, plugins and MCP servers load in it too. They see `AUTO_LEARN_CAPTURE=1` in their environment, which tells them they run in a review. auto-learn's own hooks do nothing there. A Stop hook that keeps turns going can keep a fork running until its 10-turn limit. Plugins that keep a state file per session, and Claude Code's own `~/.claude/session-env`, create one for each review, as they do for any session.

## Limitations

- A review runs in the background after the turn and may still be running when you send the next prompt. Pressing Esc does not stop it; ending the session does, so the review of the turn right before you exit is usually cut short.
- A session started with `--plugin-dir`, `--mcp-config` or `--append-system-prompt` is forked without those flags. Its fork has `manage_skill` only when auto-learn is installed, and with a changed system prompt the fork's first request misses the prompt cache and costs more.
- The fork runs the `claude` on `PATH`, which can be a different version from the running session.
- auto-learn reads skill overrides from your user settings only. A learned skill that project, local or managed settings hide is still in auto-learn's list.
- Claude Code tells a running session about skills that were added or whose description changed, but not about deleted ones or a changed body. A learned skill deleted during a session stays in that session's skill listing until the session restarts or is compacted.
- A process killed during a save may leave `.auto-learn.<name>.lock` in the skill library. Later changes refuse and name the lock file. Close the Claude sessions using that library before removing only the named lock file, then retry the change.
- Linked worktrees whose shared Git directory is outside the main checkout's `.git` use a layout this plugin cannot resolve safely. Give the worktree its own `.claude/skills` and `.claude/commands` directories before creating a personal skill; the tool refuses until it can check name collisions.
- Tested with Claude Code 2.1.322 on Linux only.

## Uninstall

```sh
claude plugin uninstall auto-learn@auto-learn
claude plugin marketplace remove auto-learn
```

Learned skills stay in your skill folder. List them with the `find` command under [Skills](#skills).

## Codex

auto-learn also runs in Codex, in the terminal and in the IDE extension. It works as it does in Claude Code, with one difference that matters: Codex skills go to their own folder, `~/.agents/skills`, so neither agent changes the other's skills.

### Install in Codex

```sh
codex plugin marketplace add Yashpal-0/auto-learn
codex plugin add auto-learn@auto-learn
```

Then start a Codex session, open `/hooks`, and trust auto-learn's three hooks. Codex runs a plugin's hooks only once you trust them, and a hook that an update changes needs your trust again.

To update to a later version, refresh the marketplace, which also reinstalls the plugins installed from it, and restart running Codex sessions:

```sh
codex plugin marketplace upgrade auto-learn
```

auto-learn needs:

- Node.js 18 or later on `PATH`.
- The `codex` command on `PATH`. Each review runs `codex app-server` in the background.

Codex runs hooks through a login shell (`$SHELL -lc`) with the environment it started with, so that environment and your shell profile decide the `PATH`.

### How a review works in Codex

1. At session start, the plugin tells Codex about `manage_skill` and lists the learned skills.
2. When a turn ends, the Stop hook reads the turn from the session's rollout file under `~/.codex/sessions` and counts its tool calls: commands, file changes, MCP and dynamic tool calls, subagent calls, web searches, and image views and generations. The turn is queued for review when it made at least `minToolCalls` tool calls, the session runs in the terminal or the IDE extension, and the turn did not run in plan mode. `codex exec`, MCP client and subagent sessions are not reviewed, and neither are ephemeral sessions, which keep no rollout.
3. The worker waits until the rollout records the end of the turn. It drops the turn if the turn was interrupted, if a new turn started first, or if the turn did not end within 10 minutes. A turn that another Stop hook kept going is reviewed once.
4. The review runs in a fork of the session. The worker starts `codex app-server` in the session's project folder, forks the session after the reviewed turn into an ephemeral thread with the session's model, reasoning effort and model provider, and starts one turn on the fork with the review request, which carries the same safeguards as in Claude Code and also tells Codex not to open a skill's file to read it. The fork is not saved as a session and does not appear in `codex resume`.
5. The fork runs with the approval policy `never` and a read-only sandbox, so it never prompts, and its commands cannot change files. Its configuration approves `manage_skill`, which saves skills from outside the sandbox, and every other request for approval is denied. Hooks and the `notify` program are off in the fork; your plugins and MCP servers load as in any session.
6. A review stops after 5 minutes, or as soon as Codex reports that it has called more than 3 tools other than `manage_skill`. auto-learn counts a tool call when Codex reports that it has finished, so the call that goes over the limit, and any that run alongside it, still run. A review also stops as soon as Codex reports that it has started a subagent tool, such as `spawn_agent`, which counts as one call: a subagent runs on a thread of its own, so its tool calls, tokens and saves would escape the limit and the log. Reviews of one session run one at a time, oldest first. Ending the session stops its running and queued reviews.

### Skills in Codex

Skills are saved to `~/.agents/skills/<name>/SKILL.md`, the folder Codex reads personal skills from, under the same rules as in Claude Code (see [Skills](#skills)). `create` refuses a name that a personal skill or a skill in the project's `.agents/skills` already uses. To list the learned skills:

```sh
find ~/.agents/skills -maxdepth 2 -name .auto-learn
```

Unless your approval settings say otherwise, Codex asks before each `manage_skill` call in your sessions, as it does for any MCP tool not marked read-only. To let Codex save skills without asking, choose to always allow the tool when Codex asks, or add this to `~/.codex/config.toml`:

```toml
[plugins."auto-learn@auto-learn".mcp_servers.auto-learn.tools.manage_skill]
approval_mode = "approve"
```

### Options in Codex

Codex has no plugin settings, so set the [options](#options) as the environment variables that Claude Code sets from its saved options: `CLAUDE_PLUGIN_OPTION_AUTOCAPTURE` (`true` or `false`) and `CLAUDE_PLUGIN_OPTION_MINTOOLCALLS` (a whole number). Hooks read them from the environment Codex started with:

```sh
CLAUDE_PLUGIN_OPTION_MINTOOLCALLS=8 codex
```

If you export them from your shell profile instead, Claude Code's hooks can see them too. `AUTO_LEARN_SKILLS_DIR` replaces `~/.agents/skills` in Codex, for testing.

### Log in Codex

The log is `auto-learn.log` in `~/.codex/plugins/data/auto-learn-auto-learn/` (under `$CODEX_HOME` when that is set), with the same events as in Claude Code. A Codex `capture` entry holds the review's outcome and duration, its `manage_skill` calls (`skillCalls`), its other tool calls (`otherToolCalls`) with the names of up to 10 of those tools (`otherTools`), its tokens (`inputTokens`, `cacheReadTokens`, `outputTokens`) and the skills it created, updated or deleted, counted as in Claude Code. It holds no cost, because Codex reports none.

- `otherTools` holds names only, never arguments or output: the item type for Codex's own tools, such as `commandExecution` or `webSearch`; `mcp:<server>#<tool>` for MCP tools; and `dynamic:<namespace>#<tool>` or `dynamic:<tool>` for dynamic tools.
- Calls that Codex refuses before they run, such as a goal tool or a request for escalated permissions, are not reported, so they are neither counted nor named.
- The outcome `stopped` means the review called more than 3 tools other than `manage_skill`, or started a subagent tool, and was stopped. The calls that went over the limit had already run.
- A review that was stopped, timed out, was aborted or failed after its fork started still logs its calls and skills so far, and the tokens Codex had reported. Codex reports a model request's tokens only once its reply is complete and every tool it called has finished, so a review that ends while the model is still answering or a tool still runs, as when it starts a subagent tool, logs fewer tokens than it used, or none.

```sh
tail -n 5 ~/.codex/plugins/data/auto-learn-auto-learn/auto-learn.log
```

### Cost in Codex

A review is one more turn with the session's model and reasoning effort, sent through your Codex sign-in: on a ChatGPT plan it counts toward the plan's usage limits, and with an API key it is billed. Codex reports no cost, so the log counts tokens instead. The fork starts with the same configuration and tools as the session so that its request can reuse the prompt cache the session has just written; the log's `cacheReadTokens` shows how much of a review's input came from the cache.

Measured over 25 completed reviews: a review sent a median of about 304,000 input tokens (98,000 to 1.8 million), wrote a median of about 1,400 output tokens, and took a median of 58 seconds. The median review read 81% of its input from the cache, but 4 of the 25 read none of it. 14 of the 25 saved nothing.

To spend less, raise `minToolCalls`, or turn `autoCapture` off.

### Privacy in Codex

- auto-learn reads the session's rollout file under `~/.codex/sessions` on your machine, to count tool calls and find where the turn ended.
- A review is a Codex turn like any other: the fork sends the session's conversation to the model again, through your own Codex sign-in and configuration.
- As in Claude Code, the request tells the model never to save secrets, credentials or personal data in a skill, `manage_skill` refuses content that looks like a credential, and the log holds no conversation text.

### Limitations in Codex

- A review may still be running when you send the next prompt. Pressing Esc does not stop it; ending the session does.
- The fork runs the `codex` on `PATH`, which can be a different version from the Codex running the session; an IDE extension may bundle its own. Without `codex` on `PATH`, reviews fail and the log says why.
- The fork reads your configuration from disk. Settings you gave the session on the command line, such as `-c` overrides, do not reach it; the session's model, reasoning effort and model provider do.
- The read-only sandbox still lets read-only tools and commands run in the fork, as well as tools you always allow. The request tells Codex to use only `manage_skill`. The log counts and names any other tool calls, and a review is stopped once more than 3 of them have run, or once it starts a subagent tool. Codex's `tool_search`, which loads `manage_skill`, is not counted.
- On Linux, a command that the fork leaves running, such as a long command that Codex moved to the background, keeps running in the read-only sandbox after the review ends. Codex does not stop its sandboxed commands when it exits, in sessions as well as in reviews; seen with bubblewrap 0.11.1.
- A learned skill that `[[skills.config]]` in your Codex configuration disables is still in auto-learn's list.
- `create` checks the project's own `.agents/skills`, but not those of the folders above it up to the repository root, which Codex also reads.
- Tested with Codex 0.168.0 on Linux only. The subagent stop, the refused calls that the log leaves out and the commands left running were checked with a 0.169.0 build; the stop for the `multi_agent_v2` feature's subagent tools follows the 0.169.0 source and has not been run.

### Uninstall from Codex

```sh
codex plugin remove auto-learn@auto-learn
codex plugin marketplace remove auto-learn
```

Learned skills stay in `~/.agents/skills`. If `~/.codex/plugins/data/auto-learn-auto-learn` is still there afterwards, delete it to remove the log.

## GitHub Copilot

auto-learn also runs in GitHub Copilot CLI and in Copilot Chat in VS Code, in chats that run on the Copilot agent host. It works as it does in Claude Code, except that Copilot skills go to their own folder, `~/.copilot/skills`, a review runs in a copy of the session through `copilot -p`, and `manage_skill` has no `read` action, no revision check and no lock.

### Install in GitHub Copilot

```sh
copilot plugin marketplace add Yashpal-0/auto-learn
copilot plugin install auto-learn@auto-learn
```

VS Code's Copilot agent host reads the plugins that Copilot CLI installed, so the same install should cover both. That comes from reading VS Code's code, and the hooks have not run in VS Code yet (see Limitations in GitHub Copilot). Reload the window, or start a new chat, to load it.

To update to a later version, then start a new session:

```sh
copilot plugin update auto-learn@auto-learn
```

auto-learn needs:

- Node.js 18 or later on `PATH`.
- The `copilot` command on `PATH`. Each review runs `copilot -p` and `copilot --headless` in the background.

In VS Code, the hooks, the MCP server and the reviews run with the environment VS Code started with, so `node` and `copilot` must be on the `PATH` it was started with.

Copilot reads the plugin from `.github/plugin/plugin.json`, which declares the plugin's Copilot hooks and MCP server. Copilot does not load the Claude Code hooks from the same repository.

### How a review works in GitHub Copilot

1. At session start, the plugin tells Copilot about `manage_skill`, which Copilot lists as `auto-learn-manage_skill`, and lists the learned skills.
2. When the agent stops, the `agentStop` hook reads the session's events file, `~/.copilot/session-state/<session>/events.jsonl`, from where the previous turn ended to the hook's own start, and counts the main agent's tool calls. Subagents' tool calls and stops are left out. Copilot writes events to that file in batches, a moment after they happen, so the hook waits up to 10 seconds for its own start to be written.
3. The turn is queued for review when it made at least `minToolCalls` tool calls, someone is at the keyboard, and the turn ran in the interactive mode. Someone is at the keyboard in a VS Code chat and in Copilot CLI's interactive interface. `copilot -p` runs, other Copilot clients, and turns in plan or autopilot mode are not reviewed.
4. The worker waits until the hook that queued the turn has finished, or for up to 10 minutes, and drops the turn if it has not. It drops the turn too when that hook asked Copilot to carry on, as another plugin's stop hook can: the stop that ends the turn is reviewed instead, with the tool calls of all the turn's stops added up. It then copies the session's events up to that point into a new session folder next to the session. The session itself is only read.
5. The worker runs `copilot -p` in the session's project folder. It resumes the copy and sends the review request. The request tells Copilot to treat instructions in files, tool output and quoted text as evidence, never to save secrets, to update or delete a skill only when its complete text is visible in the conversation, and not to open a skill's file. `--available-tools` makes `manage_skill` the only tool the model can see, and `--allow-tool` approves it, so the review never prompts. auto-learn does not choose the review's model: Copilot picks it, as for any resumed session.
6. Afterwards, the worker deletes the copy through `copilot --headless`. This also removes the copy from Copilot's session store, so it does not appear among your sessions. If that fails, the worker deletes the copy's folder itself and the log says why.
7. A review stops after 5 minutes. Reviews of one session run one at a time, oldest first. Ending the session stops its running and queued reviews.

On a fusion model, such as VS Code's Auto, Copilot writes a turn's tool calls to the events file after the turn's stop, so the stop hook cannot count them. It queues the turn anyway, and the log's `queued` entry says `fusion: true`. The worker waits for Copilot to complete the turn, counts its tool calls then, and applies the rules of step 3: a `capture` entry that says `fewer than 5 tool calls`, `plan mode` or `autopilot mode` means the turn was dropped. A fusion turn that stops more than once is reviewed at its last stop, and a turn that Copilot interrupts is not reviewed.

The review is a Copilot session with your configuration, so your other plugins' hooks and MCP servers load in it too. Their hooks see `AUTO_LEARN_CAPTURE=1`, which tells them they run in a review; auto-learn's own hooks do nothing there. Only the 5 minutes bound a review: auto-learn sets no limit on its model turns, unlike Claude Code's 10. A stop hook that keeps asking Copilot to go on keeps a review running, and billed, until they end.

### Skills in GitHub Copilot

Skills are saved to `~/.copilot/skills/<name>/SKILL.md` (under `$COPILOT_HOME` when that is set), the folder Copilot reads personal skills from, under the rules in [Skills](#skills), except that `manage_skill` has no `read` action and `update` and `delete` need no revision. `create` refuses a name that a skill in `~/.copilot/skills`, in `~/.agents/skills` (the Codex library, which Copilot reads too) or in the project's `.github/skills` already uses. Copilot lists a skill saved during a session from the next session on. To list the learned skills:

```sh
find ~/.copilot/skills -maxdepth 2 -name .auto-learn
```

Copilot asks before each `manage_skill` call in your sessions, as it does for any MCP tool. To stop being asked in a repository, answer "Yes, and don't ask again". To allow it for one run, start Copilot with `--allow-tool='auto-learn(manage_skill)'`.

### Options in GitHub Copilot

Copilot has no plugin settings, so set the [options](#options) as the environment variables `CLAUDE_PLUGIN_OPTION_AUTOCAPTURE` (`true` or `false`) and `CLAUDE_PLUGIN_OPTION_MINTOOLCALLS` (a whole number). Hooks read them from the environment Copilot started with:

```sh
CLAUDE_PLUGIN_OPTION_MINTOOLCALLS=8 copilot
```

In VS Code, hooks get the environment VS Code started with, so set the variables before you start VS Code, and restart it after changing them. Without them the defaults hold: `autoCapture` on and `minToolCalls` 5.

`AUTO_LEARN_SKILLS_DIR` replaces `~/.copilot/skills` in Copilot, for testing.

### Log in GitHub Copilot

The log is `auto-learn.log` in `~/.copilot/plugin-data/auto-learn/auto-learn/` (under `$COPILOT_HOME` when that is set), with the same events as in Claude Code. A `queued` entry says `fusion: true` for a fusion turn. A Copilot `capture` entry holds the review's outcome and duration, its `manage_skill` calls (`skillCalls`), its other tool calls (`otherToolCalls`) with the names of up to 10 of those tools (`otherTools`), the AI credits Copilot reported for it (`aiCredits`), its tokens (`inputTokens`, `cacheReadTokens`, `outputTokens`), and the skills it created, updated or deleted. `cleanupError` says why deleting the copy through `copilot --headless` failed.

```sh
tail -n 5 ~/.copilot/plugin-data/auto-learn/auto-learn/auto-learn.log
```

### Cost in GitHub Copilot

A review is one more prompt, sent through your Copilot sign-in, so it counts toward your plan's premium requests or AI credits like any other prompt. Copilot reports no cost in money, so the log records the AI credits and tokens Copilot reported for the review's model requests. Copilot picks the review's model, so a review of a session on a fusion model such as Auto may run on it, with several model requests for one prompt. auto-learn has not measured this or reviews on GitHub's models; the log's `aiCredits` shows what each review cost.

To spend less, raise `minToolCalls`, or turn `autoCapture` off.

### Privacy in GitHub Copilot

- auto-learn reads the session's `events.jsonl` and `workspace.yaml` under `~/.copilot/session-state` on your machine, to count tool calls, find where the turn ended, and tell which client runs the session.
- The copy of the session is a folder next to the session's own, deleted when the review ends.
- A review is a Copilot prompt like any other: it sends the session's conversation to the model again, through your own Copilot sign-in and configuration.
- Copilot does not pass `COPILOT_PROVIDER_*` or `COPILOT_OFFLINE` to hooks. A session that runs on your own model provider, offline, or on a BYOK model picked in VS Code is therefore not reviewed by that provider: the standalone `copilot` that runs the review resumes the copy on your Copilot sign-in, so the conversation goes to GitHub's models, or the review fails and the log says why. Which of the two happens for a BYOK model picked in VS Code has not been verified. Turn `autoCapture` off if you do not want that.
- As in Claude Code, the request tells the model never to save secrets, credentials or personal data in a skill, `manage_skill` refuses content that looks like a credential, and the log holds no conversation text.

### Limitations in GitHub Copilot

- A review may still be running when you send the next prompt. Pressing Esc does not stop it; ending the session does.
- In Copilot CLI, auto-learn tells the interactive interface from `copilot -p` by the `COPILOT_LOADER_PID` variable that the interface sets. A `copilot -p` run started from inside an interactive session, such as by the agent's shell tool, inherits it, so its turns are queued too, but their reviews stop when the run ends, right after its last turn.
- Reviews run the `copilot` on `PATH`, which can be a different version from the Copilot running the session; VS Code runs its own copy. Without `copilot` on `PATH`, reviews fail and the log says why.
- A review does not use a model provider set with `COPILOT_PROVIDER_*` or a saved BYOK provider, since Copilot does not pass those to hooks (see Privacy).
- If `copilot --headless` cannot delete the copy, the copy's record in Copilot's session store stays behind. If the worker is killed mid-review, such as by a reboot or `kill -9`, the copy stays too, as a session named "auto-learn skill review" in `~/.copilot/session-state` that Copilot lists among your sessions. Delete it there.
- A learned skill that your Copilot configuration disables is still in auto-learn's list.
- `create` checks `~/.copilot/skills`, `~/.agents/skills` and the `.github/skills` of the session's working folder. It does not check the project's `.agents/skills` and `.claude/skills`, or the `.github/skills` of the folders up to the repository root, which Copilot reads too.
- Copilot's `manage_skill` has no revision check and no lock, so two sessions that save the same skill at once can overwrite each other, and an `update` replaces whatever the skill holds when it runs.
- A turn whose stop hook asked Copilot to carry on is reviewed at its final stop. If Copilot does not carry on, for example because you interrupt it, the turn is not reviewed. For a fusion turn that is continued this way, only the tool calls after its last stop count.
- Reviews start `copilot` without a shell, so on Windows it must be a real executable, not an npm `copilot.cmd` shim. auto-learn has not been tried on Windows.
- In VS Code, only chats on the Copilot agent host are covered. auto-learn has not been tried with VS Code's other chat session types.
- Tested with Copilot CLI 1.0.114 on Linux, with a stand-in model, and with VS Code's Auto turns replayed from sessions VS Code 1.147 wrote. The hooks have not run inside VS Code yet. Its sessions show `agentStop` firing when each turn ends and `sessionEnd` only when a session closes, which is what auto-learn relies on.

### Uninstall from GitHub Copilot

```sh
copilot plugin uninstall auto-learn@auto-learn
copilot plugin marketplace remove auto-learn
```

Learned skills stay in `~/.copilot/skills`. If `~/.copilot/plugin-data/auto-learn` is still there afterwards, delete it to remove the log.

## Antigravity CLI

auto-learn also runs in Antigravity CLI, the `agy` command. It works as it does in Claude Code, except that skills go to Antigravity's own folder, `~/.gemini/config/skills`, and a review runs as a separate `agy -p` conversation.

### Install in Antigravity CLI

```sh
agy plugin install https://github.com/Yashpal-0/auto-learn
```

agy clones the repository and installs it as `~/.gemini/config/plugins/auto-learn`. Start a new `agy` session to load it. `agy plugin list` shows it as `auto-learn (enabled, <version>)`.

To update to a later version, run the same command again, which replaces the installed copy (agy has no `agy plugin update`), then start a new session.

auto-learn needs:

- Node.js 18 or later on `PATH`. agy runs the plugin's hooks and its MCP server with `node`.
- The `agy` command on `PATH`. Each review runs `agy -p` in the background.

agy reads the plugin from `.antigravity-plugin/plugin.json`, `hooks.json`, `mcp_config.json` and `agents/auto-learn-review.md` at the root of the repository. It does not load the Claude Code hooks in `hooks/`.

### How a review works in Antigravity CLI

1. At the start of a conversation, the plugin adds a system message that tells the model about `manage_skill`, which agy lists as `mcp_auto-learn_auto-learn_manage_skill`, and lists the learned skills.
2. When the agent stops, the `Stop` hook reads the conversation's transcript, `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl`, from where the previous turn started. It finds the turn that just ended and counts the main agent's tool calls. agy runs the `Stop` hook several times in one turn, so a review is queued at the first stop where the turn qualifies, and never twice for the same prompt.
3. The turn is queued for review when it made at least `minToolCalls` tool calls, someone is at the keyboard, the turn was neither canceled (`USER_CANCELED`) nor ended by an error (`ERROR`), and the prompt was not typed as `/plan ...` or `/goal ...`. Someone is at the keyboard when `agy` runs in a terminal, also as `agy -i "prompt"`. Runs of `agy -p`, `agy acp`, `--hub` and `--remote-agent`, and conversations of the Antigravity IDE and app, are not reviewed. The hook learns how agy was started from the process that runs it, which it reads from `/proc`, so automatic reviews work on Linux only.
4. A detached worker writes the turn out as text, the excerpt: your prompt, the agent's replies, and each tool call with its arguments and result. Each is clipped, to 4,000 characters for your prompt, 2,000 for a reply, 600 for arguments and 1,200 for a result, and the whole excerpt to 60,000. A line says how many steps were left out. The agent's reasoning is not included.
5. The worker runs `agy -p` with the `auto-learn-review` agent, in a conversation store of its own, `~/.gemini/auto-learn-review`, so the review never appears among your conversations. The excerpt and the review request go in on stdin. The excerpt sits between two marker lines that carry a random token, which the request names, so a line in the excerpt that looks like a marker is the turn's own text. The request tells the model to treat instructions in files, tool output and quoted text as evidence, never to save secrets, and to read a managed skill with `manage_skill` (action `read`) and pass its `revision` before updating or deleting it. The agent file asks for no tools, and agy runs the review with the permission mode `always-proceed` so that it never prompts. agy still lists its whole tool registry, so auto-learn watches the review's output. It stops the review at the first call of any tool but `manage_skill`, and at the start if agy runs it under another agent than `auto-learn-review`: the log's outcome is then `stopped`, with the reason. The call that stops it may already have started. A `manage_skill` call counts as a save only when agy reports it done without an error and a line of its output begins with the message `manage_skill` prints for that action and skill. auto-learn does not choose the review's model: agy picks its default.
6. Afterwards, the worker deletes the review's conversation and ends anything of the review's process group that still runs, however the review ended. A conversation that a killed worker left behind is deleted by the next review once it is an hour old.
7. A review stops after 5 minutes. agy has no session-end hook, so ending the session does not stop a running review.

In your own sessions the model can also save a skill itself, with `manage_skill`. When it does, the review that follows often finds nothing to add: it saves a skill only when the turn holds more than the model saved.

### Skills in Antigravity CLI

Skills are saved to `~/.gemini/config/skills/<name>/SKILL.md`, the folder agy reads personal skills from, under the same rules as in Claude Code (see [Skills](#skills)), including `read`, SHA-256 `revision` checks on `update` and `delete`, and per-skill locks across MCP processes (the Claude-only reserved names `synced` and `anthropic-skills` do not apply). `create` refuses a name that a skill in `~/.gemini/config/skills`, `~/.agents/skills`, `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills` or among agy's built-in skills already uses (by folder name or declared frontmatter `name:`), and a name that a skill in the project's `.agents/skills` uses when the call comes from a review. A call in your own session cannot check the project, because agy starts the plugin's MCP server in the plugin's folder, not in your project. agy rereads skills before each turn, so a saved skill is offered on the next turn in the same conversation as well as in later conversations (run `/skills reload` to refresh the `/skills` panel and slash-command menu mid-session), and the plugin's session-start message lists learned skills with what each is for. The Antigravity IDE and app share `~/.gemini/config` with the CLI and may offer these skills as well; auto-learn has not checked that. To list the learned skills:

```sh
find ~/.gemini/config/skills -maxdepth 2 -name .auto-learn
```

agy may ask before a `manage_skill` call in your own sessions, as it can for any MCP tool. auto-learn has not checked what agy's default settings do, because its tests ran with `toolPermission` set to `always-proceed`. Reviews do not depend on it: the worker starts them with that mode.

### Options in Antigravity CLI

The plugin has no settings in agy, so set the [options](#options) as the environment variables `CLAUDE_PLUGIN_OPTION_AUTOCAPTURE` (`true` or `false`) and `CLAUDE_PLUGIN_OPTION_MINTOOLCALLS` (a whole number) before you start `agy`:

```sh
CLAUDE_PLUGIN_OPTION_MINTOOLCALLS=8 agy
```

Without them the defaults hold: `autoCapture` on and `minToolCalls` 5.

`AUTO_LEARN_SKILLS_DIR` replaces `~/.gemini/config/skills` in agy, for testing.

### Log in Antigravity CLI

The log is `auto-learn.log` in `~/.gemini/antigravity-cli/plugin_data/auto-learn/`, with the same events as in Claude Code. A `queued` entry adds agy's `terminationReason` for the turn. A `skip` entry says why a turn was not reviewed: `unattended session`, `canceled`, `error`, `plan mode`, `goal mode`, `fewer than 5 tool calls`, `the transcript has no turn` or `already queued`. A `capture` entry holds the review's outcome and duration, its `manage_skill` calls (`skillCalls`), its other tool calls (`otherToolCalls`) with the names of up to 10 of those tools (`otherTools`), the tool that stopped it (`stoppedTool`), the actions agy refused it for want of permission (`deniedActions`), its tokens (`inputTokens`, `cacheReadTokens`, `outputTokens`), and the skills it created, updated or deleted. `cleanupError` says why deleting the review's conversation failed. A review that agy cannot run, for instance while it asks you to verify your account, ends with the outcome `error` and the end of agy's message, up to 500 characters, with each link cut down to its host and path, because a sign-in link carries a token.

```sh
tail -n 5 ~/.gemini/antigravity-cli/plugin_data/auto-learn/auto-learn.log
```

### Cost in Antigravity CLI

A review is one more `agy -p` conversation, on agy's default model through your agy sign-in, so it uses the quota that comes with that sign-in. agy reports tokens but no cost in money. Two reviews on agy 1.5.19 took 30 seconds (creating one skill: 14,444 input tokens, 5,978 cached, 1,410 output tokens) and 49 seconds (reading and updating that skill: 26,384 input tokens, 14,844 cached, 3,541 output tokens). The excerpt can hold up to 60,000 characters, so a review of a long turn costs more. The log's `inputTokens`, `cacheReadTokens` and `outputTokens` show what each review used.

To spend less, raise `minToolCalls`, or turn `autoCapture` off.

### Privacy in Antigravity CLI

- auto-learn reads the conversation's transcript under `~/.gemini/antigravity-cli/brain` on your machine, to count tool calls, find the turn and write the excerpt.
- A review is an `agy -p` prompt like any other: it sends the excerpt, up to 60,000 characters of the turn, to the model behind your agy sign-in.
- The review's conversation is deleted when the review ends. agy keeps a one-line summary of each deleted conversation in the review store's database, `~/.gemini/auto-learn-review/conversation_summaries.db`: the review's fixed first line, `[auto-learn review]`, and the path of the review's workspace folder. After reviews on agy 1.5.14, a search of the review store and of agy's CLI store found none of the excerpt's words. Other folders of agy were not searched.
- As in Claude Code, the request tells the model never to save secrets, credentials or personal data in a skill, `manage_skill` refuses content that looks like a credential, and the log holds no conversation text. When a review fails, the log's `error` holds up to 500 characters of agy's own message, with each link cut down to its host and path.

### Limitations in Antigravity CLI

- A review may still be running when you end the session or start the next prompt. It ends by itself within 5 minutes.
- Automatic reviews need `/proc`, so they work on Linux only. Elsewhere the log says `unattended session` and nothing is reviewed; the model can still use `manage_skill` itself.
- Conversations of the Antigravity IDE and app are not reviewed. A session started with `agy --mode plan` is reviewed like any other: only a prompt typed as `/plan ...` or `/goal ...` is skipped.
- The review agent, `auto-learn-review`, is part of the plugin, so `agy agents` lists it, and so do Claude Code (as `auto-learn:auto-learn-review`) and Copilot CLI, which warns that it ignores some of the agent's fields. It is not for delegation, and its description says so.
- auto-learn watches the review's tool calls and stops it at the first one that is not `manage_skill`, but that call may already have started, and the agent file's empty tool list is not a limit agy enforces: agy still lists its whole tool registry.
- A process killed during a save may leave `.auto-learn.<name>.lock` in `~/.gemini/config/skills`. Later changes refuse and name the lock file. Close the Antigravity sessions using that library before removing only the named lock file, then retry the change.
- If the worker is killed in the middle of a review, such as by a reboot or `kill -9`, the review's conversation stays in `~/.gemini/auto-learn-review` until the next review deletes it, once it is an hour old.
- A learned skill that you or agy disabled is still in auto-learn's list.
- agy's own `manage_skill`-style prompts, workspace trust and first-run screens are not auto-learn's: it never answers them. The first run of agy in a new home shows a theme picker and a data-collection consent screen, which auto-learn does not touch. The tests ran in a workspace that agy's settings trust; a global plugin's hooks in a workspace you have not trusted yet have not been checked.
- How agy reports a `manage_skill` call that failed has not been seen in a stream. auto-learn counts a save only on the confirmation described above, so a failure in a shape it does not know is not counted as a save.
- Tested with agy 1.5.19 on Linux, in a separate home, with the real model: creating a skill, reading and updating that skill with a revision, autonomous invocation in a fresh conversation, and next-turn discovery of a skill saved mid-conversation. Not tried: macOS, Windows, conversation compaction, resuming a conversation, `--mode auto`, `--hub` and remote control, an agy that the updater replaced with a newer version, and the Antigravity IDE and app.

### Uninstall from Antigravity CLI

```sh
agy plugin uninstall auto-learn
```

Learned skills stay in `~/.gemini/config/skills`. Uninstalling leaves the log's folder, `~/.gemini/antigravity-cli/plugin_data/auto-learn`, and the review store, `~/.gemini/auto-learn-review`; delete them to remove the log and the review summaries.

## OpenCode

auto-learn runs as a native OpenCode V2 server plugin. It adds `manage_skill` in the `auto_learn` namespace, lists discoverable learned skills in session instructions, and refreshes OpenCode's skill catalog after a save. The list is built when a session first runs and again after each compaction, because it sits in the cached prompt prefix: a skill saved mid-session appears after the next compaction or in a new session. It does not need a separate MCP server or the `claude` or `codex` commands.

OpenCode's file watcher discovers new skill files asynchronously, so the catalog can lag a successful save briefly. Tested with OpenCode `2.3.2-dev` on Linux, using a local deterministic provider for manual and automatic saves; real-provider costs and cache reuse remain unmeasured.

### Install in OpenCode

Install directly from GitHub:

```sh
opencode plugin add github:Yashpal-0/auto-learn
opencode plugin list
```

OpenCode installs the package and adds it to your global configuration. Watched configuration changes reload plugins automatically; use `opencode reload` if you need to force a reload. Do not copy the Claude/Codex hooks into OpenCode: those hosts use different plugin APIs.

To check or install a later GitHub update:

```sh
opencode plugin check
opencode plugin update github:Yashpal-0/auto-learn
```

### How a review works in OpenCode

1. A successfully completed root-session turn is eligible when it contains a user prompt (or continued from an automatic mid-turn compaction), used at least `minToolCalls` tools (including nested tool calls inside Code Mode `execute`, and calls made before an automatic compaction, which the session context no longer shows and the plugin counts from OpenCode's tool events), and did not use the `plan` agent. Child/subagent sessions, failed or interrupted turns, manual compactions, and synthetic-only work are not reviewed. A turn that auto-compacted no longer shows what started it, so it is reviewed even when a synthetic wake-up, not a prompt, started it. Root sessions from `opencode run` are eligible too; OpenCode's public plugin API does not identify whether someone is at the keyboard.
2. The plugin requests a transient generation from the session's current context, using OpenCode's selected model and variant. This is not a new conversation turn or a fork: no review prompt or reply is added to history, and no review session appears in the session list. OpenCode counts the review's usage in the original session's totals.
3. The review executes no tools. It returns JSON `null` or one proposed skill to create or update. The plugin validates the response and passes a proposal through the same skill store as `manage_skill`, including ownership, size, name and credential checks. Automatic reviews cannot delete skills.
4. A new prompt or execution, moving or deleting the session, plugin unload, or a five-minute deadline discards a pending review result. At most one review runs per session and four per plugin location; turns that exceed that limit are skipped rather than queued. Reviews use no subprocesses.

The OpenCode Promise plugin API currently does not propagate request cancellation options. Discarding a review result prevents a late response from starting a save, but an already-sent provider request may finish and consume tokens. A filesystem write already in progress may also finish, so a review logged as `aborted` or `timeout` may still have saved its skill.

### Skills and permissions in OpenCode

Skills go to `~/.config/opencode/skills/<name>/SKILL.md`, or `$XDG_CONFIG_HOME/opencode/skills` when set. When `OPENCODE_CONFIG_DIR` is set, they go to `$OPENCODE_CONFIG_DIR/skills`, the global skill folder OpenCode then reads. `AUTO_LEARN_SKILLS_DIR` overrides that location for testing; OpenCode must discover an override before it can offer those skills. As in the other hosts, the `.auto-learn` marker identifies skills the plugin may change.

An update replaces the skill's full description and instructions. The review is told to update only when its current text is visible and to preserve useful steps, but model-written edits can still lose details. Remove the `.auto-learn` marker to keep a skill under your control.

Before creating a skill, the plugin checks OpenCode's full discovered catalog, including compatibility folders, ancestor project folders, flat Markdown skills and configured sources. An existing skill with the same ID is never overwritten. Updating or deleting still requires a managed skill in OpenCode's own library; installing this plugin does not migrate or change your existing Claude/Codex skills.

The permission action is `auto_learn_manage_skill`, with the skill name as its resource. Normal calls follow your OpenCode permission rules. Automatic saves obey those rules too, but refuse an `ask` result instead of opening a background permission prompt. If your rules require approval by default, allow this tool to enable automatic saves:

```jsonc
{
  "permissions": [
    { "action": "auto_learn_manage_skill", "resource": "*", "effect": "allow" }
  ]
}
```

This grants writes only through the managed skill store; it does not grant shell access or general file editing.

### Options in OpenCode

Use the existing plugin entry in `~/.config/opencode/opencode.json(c)` rather than adding a second copy:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:Yashpal-0/auto-learn",
      "options": {
        "autoCapture": true,
        "minToolCalls": 5
      }
    }
  ]
}
```

`autoCapture: false` leaves manual `manage_skill` calls available. `minToolCalls` must be a non-negative whole number; `0` reviews successful user turns with no tools. Unlike the Claude/Codex hooks, OpenCode reads these native options rather than `CLAUDE_PLUGIN_OPTION_*` environment variables.

### Log, cost and privacy in OpenCode

The activity log is `~/.local/share/opencode/auto-learn/auto-learn.log`, or `$XDG_DATA_HOME/opencode/auto-learn/auto-learn.log`. It uses the same `queued`, `skip` and `capture` events and 1 MiB rotation as the other hosts. A capture records its outcome, duration, available usage/cost figures, and the names of skills it saved, never conversation text or the model's raw review response. Review bookkeeping uses OpenCode's plugin-scoped storage.

A review is an extra request through the session's provider and account. Prompt-cache reuse and real-provider costs have not been measured. The local log records usage reported by OpenCode; those tokens and costs are also included in the session's totals. Raise `minToolCalls` or turn off `autoCapture` to reduce usage.

The plugin does not read OpenCode's database or send conversations to a separate service. OpenCode resends the session context to its configured model provider for each review. Skills remain local, and the shared credential checks also apply to OpenCode saves.

### Uninstall from OpenCode

```sh
opencode plugin remove github:Yashpal-0/auto-learn
```

Learned skills and the activity log remain. Remove the `.auto-learn` marker from a skill to take ownership, as in the other hosts.

## Development

The plugin has no dependencies. Run the tests with:

```sh
node --test test/*.test.mjs
```

`claude --plugin-dir .` loads the hooks and `manage_skill` from a checkout, but its reviews run without them, because forks do not inherit `--plugin-dir`. To try reviews from a checkout, install it from the local folder:

```sh
claude plugin marketplace add ./
claude plugin install auto-learn@auto-learn
```

In Codex, install a checkout the same way. Codex copies the plugin when you add it, so remove it and add it again after a change:

```sh
codex plugin marketplace add ./
codex plugin add auto-learn@auto-learn
```

In Copilot, add the checkout as a local marketplace. Copilot loads a plugin from a local marketplace in place, without copying it, so a new session picks up each change:

```sh
copilot plugin marketplace add ./
copilot plugin install auto-learn@auto-learn
```

In Antigravity CLI, install the checkout from its folder. agy copies the plugin when you install it, so install it again after a change:

```sh
agy plugin install ./
```

In OpenCode V2, load the checkout as a plugin directory in your project configuration:

```jsonc
{
  "plugins": ["/absolute/path/to/auto-learn"]
}
```

To test the packed package in an isolated real OpenCode server with a deterministic local model provider, without using your account or changing your configuration:

```sh
node test/opencode-live.mjs
```

## License

[MIT](LICENSE)
