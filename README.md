# auto-learn

auto-learn lets Claude Code, Codex and OpenCode learn skills from your own work. After a turn in which the agent worked something out, such as how to build or test a project, the fix for an error or a setup sequence, a background review looks back at the turn and saves the procedure as a personal skill. The agent then offers that skill whenever a later task matches it.

Each agent can also save skills during a session with the `manage_skill` tool that the plugin adds.

Each host writes to its own skill library: see [Codex](#codex) and [OpenCode](#opencode) for their installation and behavior.

## Install in Claude Code

```sh
claude plugin marketplace add Yashpal-0/auto-learn
claude plugin install auto-learn@auto-learn
```

Restart running Claude Code sessions afterwards: hooks load when a session starts.

auto-learn needs:

- Node.js 18 or later on `PATH`. The hooks and the MCP server are Node scripts with no dependencies.
- The `claude` command on the `PATH` that Claude Code passes to its hooks. Each review runs `claude` in the background.

## How a review works in Claude Code

1. At session start, the plugin tells Claude about `manage_skill` and where skills are saved, and lists the learned skills (see [Skills](#skills)).
2. When a turn ends, the Stop hook counts the turn's tool calls. The turn is queued for review when it made at least `minToolCalls` tool calls (5 by default), the session has someone at the keyboard (the terminal, an IDE, the desktop app), and the session is not in plan mode. `claude -p`, SDK and background sessions are not reviewed. The hook returns at once and starts a worker; you carry on while the review runs.
3. The worker waits until the turn is written to the session transcript, then finds its last message. It drops the turn if another Stop hook kept the turn going, if a new prompt arrived first, or if a `/goal` is still being worked on.
4. The review runs in a fork of the session:

   ```sh
   claude -p --resume <session> --resume-session-at <last message> --fork-session --no-session-persistence
   ```

   with the session's model and effort, in the session's project folder. The fork sees the conversation up to the end of that turn, exactly as the session did, and reads it from the prompt cache the session has just written. It receives one request: look back at the turn and, if it worked out a procedure that a later session would otherwise have to discover again, save it with `manage_skill`; otherwise save nothing. The fork is not saved as a session and does not appear in `/resume`.
5. Only `manage_skill` runs in the fork. A PreToolUse hook refuses every other tool, and the fork runs in `dontAsk` permission mode, so it never prompts, edits files or runs commands. ToolSearch is allowed so that the fork can load the `manage_skill` schema. A hook cannot refuse the server-side advisor tool, so the request tells Claude not to use it, and the log counts any advisor calls.
6. A review stops after 10 model turns or 5 minutes. Reviews of one session run one at a time, oldest first. Ending the session (exiting, `/clear`, or switching to another session with `/resume`) stops its running and queued reviews.

Each queued, skipped and finished review is recorded in the [log](#log).

## Skills

Skills are saved to `~/.claude/skills/<name>/SKILL.md` (`$CLAUDE_CONFIG_DIR/skills` when that is set), the folder Claude Code reads personal skills from. Each skill that auto-learn creates also holds a `.auto-learn` marker file.

- Names are lowercase letters and digits with single hyphens between words, 1 to 64 characters, for example `deploy-docs`.
- A `SKILL.md` is at most 32 KiB, frontmatter included, and its description at most 1,024 characters.
- A skill that contains what looks like a credential is refused: private keys, API keys, and GitHub, GitLab, Slack, AWS and Google tokens, and JSON Web Tokens.
- `create` refuses a name that any skill already uses, in your personal skills or in the project's `.claude/skills`.
- `update` and `delete` work only on skills that carry the marker, and never through a symbolic link. Skills you wrote, and skills linked in from elsewhere, are never changed.

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
- `capture`: a review finished, with its outcome (`ok`, `skipped`, `aborted`, `timeout` or `error`) and, for a review that ran, its model turns, duration, tokens, cost, advisor calls, refused tool calls, and the skills it created, updated or deleted.

`costUsd` is what the review itself cost, at list price. When a session has been resumed, Claude Code starts a fork's cost counter from the cost it recorded for the session when it last exited, so the total it reports for the fork includes the session's earlier cost. auto-learn reads that recorded cost from `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set), subtracts it, and logs it as `sessionCostUsd`. If that file exists but cannot be read, auto-learn logs Claude Code's total as `reportedCostUsd` instead of `costUsd`. Version 0.1.0 logged that total as `costUsd`, so its entries for resumed sessions overstate what reviews cost.

The log holds no conversation text. It is readable only by you, and it rotates at 1 MiB, keeping one older file as `auto-learn.log.1`. `claude plugin uninstall` deletes it along with the data folder unless you pass `--keep-data`.

```sh
tail -n 5 ~/.claude/plugins/data/auto-learn-auto-learn/auto-learn.log
```

## Cost

A review is one to five more Claude requests on your account, with the session's model; saving a skill takes more of them. Each request sends the session's whole context again. Reading that context from the prompt cache is cheap, but the reply, thinking included, is billed in full, so on a large model a review costs real money. The cost grows with the length of the session.

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

To spend less, raise `minToolCalls`, or turn `autoCapture` off and leave saving skills to Claude during the session.

## Privacy

- auto-learn reads the session transcript under `~/.claude/projects` on your machine, to count tool calls and find where the turn ended.
- auto-learn reads Claude Code's `~/.claude.json` for the cost Claude Code recorded for the session, and logs only that number.
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

auto-learn needs:

- Node.js 18 or later on `PATH`.
- The `codex` command on `PATH`. Each review runs `codex app-server` in the background.

Codex runs hooks through a login shell (`$SHELL -lc`) with the environment it started with, so that environment and your shell profile decide the `PATH`.

### How a review works in Codex

1. At session start, the plugin tells Codex about `manage_skill` and lists the learned skills.
2. When a turn ends, the Stop hook reads the turn from the session's rollout file under `~/.codex/sessions` and counts its tool calls: commands, file changes, MCP and dynamic tool calls, subagent calls, web searches, and image views and generations. The turn is queued for review when it made at least `minToolCalls` tool calls, the session runs in the terminal or the IDE extension, and the turn did not run in plan mode. `codex exec`, MCP client and subagent sessions are not reviewed, and neither are ephemeral sessions, which keep no rollout.
3. The worker waits until the rollout records the end of the turn. It drops the turn if the turn was interrupted, if a new turn started first, or if the turn did not end within 10 minutes. A turn that another Stop hook kept going is reviewed once.
4. The review runs in a fork of the session. The worker starts `codex app-server` in the session's project folder, forks the session after the reviewed turn into an ephemeral thread with the session's model, reasoning effort and model provider, and starts one turn on the fork with the review request. The fork is not saved as a session and does not appear in `codex resume`.
5. The fork runs with the approval policy `never` and a read-only sandbox, so it never prompts, and its commands cannot change files. Its configuration approves `manage_skill`, which saves skills from outside the sandbox, and every other request for approval is denied. Hooks and the `notify` program are off in the fork; your plugins and MCP servers load as in any session.
6. A review stops after 5 minutes. Reviews of one session run one at a time, oldest first. Ending the session stops its running and queued reviews.

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

The log is `auto-learn.log` in `~/.codex/plugins/data/auto-learn-auto-learn/` (under `$CODEX_HOME` when that is set), with the same events as in Claude Code. A Codex `capture` entry holds the review's outcome and duration, its `manage_skill` calls (`skillCalls`), its other tool calls (`otherToolCalls`), its tokens (`inputTokens`, `cacheReadTokens`, `outputTokens`) and the skills it created, updated or deleted. It holds no cost, because Codex reports none.

```sh
tail -n 5 ~/.codex/plugins/data/auto-learn-auto-learn/auto-learn.log
```

### Cost in Codex

Not yet measured. A review is one more turn with the session's model and reasoning effort, sent through your Codex sign-in: on a ChatGPT plan it counts toward the plan's usage limits, and with an API key it is billed. The fork starts with the same configuration and tools as the session so that its request can reuse the prompt cache the session has just written; whether it does is not yet measured either. The log's `cacheReadTokens` shows how much of a review's input came from the cache. To spend less, raise `minToolCalls`, or turn `autoCapture` off.

### Privacy in Codex

- auto-learn reads the session's rollout file under `~/.codex/sessions` on your machine, to count tool calls and find where the turn ended.
- A review is a Codex turn like any other: the fork sends the session's conversation to the model again, through your own Codex sign-in and configuration.
- As in Claude Code, the request tells the model never to save secrets, credentials or personal data in a skill, `manage_skill` refuses content that looks like a credential, and the log holds no conversation text.

### Limitations in Codex

- A review may still be running when you send the next prompt. Pressing Esc does not stop it; ending the session does.
- The fork runs the `codex` on `PATH`, which can be a different version from the Codex running the session; an IDE extension may bundle its own. Without `codex` on `PATH`, reviews fail and the log says why.
- The fork reads your configuration from disk. Settings you gave the session on the command line, such as `-c` overrides, do not reach it; the session's model, reasoning effort and model provider do.
- The read-only sandbox still lets read-only tools and commands run in the fork, as well as tools you always allow. The request tells Codex to use only `manage_skill`, and the log counts any other tool calls as `otherToolCalls`.
- A learned skill that `[[skills.config]]` in your Codex configuration disables is still in auto-learn's list.
- `create` checks the project's own `.agents/skills`, but not those of the folders above it up to the repository root, which Codex also reads.
- Tested with Codex 0.168.0 on Linux only.

### Uninstall from Codex

```sh
codex plugin remove auto-learn@auto-learn
codex plugin marketplace remove auto-learn
```

Learned skills stay in `~/.agents/skills`. If `~/.codex/plugins/data/auto-learn-auto-learn` is still there afterwards, delete it to remove the log.

## OpenCode

auto-learn runs as a native OpenCode V2 server plugin. It adds `manage_skill` in the `auto_learn` namespace, lists discoverable learned skills in session instructions, and refreshes OpenCode's skill catalog after a save. It does not need a separate MCP server or the `claude` or `codex` commands.

OpenCode's file watcher discovers new skill files asynchronously, so the catalog can lag a successful save briefly. Tested with OpenCode `2.3.0-dev` on Linux, using a local deterministic provider for manual and automatic saves; real-provider costs and cache reuse remain unmeasured.

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

1. A successfully completed root-session turn is eligible when it contains a user prompt, used at least `minToolCalls` tools, and did not use the `plan` agent. Child/subagent sessions, failed or interrupted turns, and synthetic-only work are not reviewed. Root sessions from `opencode run` are eligible too; OpenCode's public plugin API does not identify whether someone is at the keyboard.
2. The plugin requests a transient generation from the session's current context, using OpenCode's selected model and variant. This is not a new conversation turn or a fork: no review prompt or reply is added to history, and no review session appears in the session list. OpenCode counts the review's usage in the original session's totals.
3. The review executes no tools. It returns JSON `null` or one proposed skill to create or update. The plugin validates the response and passes a proposal through the same skill store as `manage_skill`, including ownership, size, name and credential checks. Automatic reviews cannot delete skills.
4. A new prompt or execution, moving or deleting the session, plugin unload, or a five-minute deadline discards a pending review result. At most one review runs per session and four per plugin location; turns that exceed that limit are skipped rather than queued. Reviews use no subprocesses.

The OpenCode Promise plugin API currently does not propagate request cancellation options. Discarding a review result prevents a late response from starting a save, but an already-sent provider request may finish and consume tokens. A filesystem write already in progress may also finish.

### Skills and permissions in OpenCode

Skills go to `~/.config/opencode/skills/<name>/SKILL.md`, or `$XDG_CONFIG_HOME/opencode/skills` when set. `AUTO_LEARN_SKILLS_DIR` overrides that location for testing; OpenCode must discover an override before it can offer those skills. As in the other hosts, the `.auto-learn` marker identifies skills the plugin may change.

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
