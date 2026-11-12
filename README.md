# auto-learn

auto-learn lets Claude Code learn skills from your own work. After a turn in which Claude worked something out, such as how to build or test a project, the fix for an error or a setup sequence, a background copy of the session looks back at the turn and saves the procedure as a personal skill. Claude Code then offers that skill in later sessions whenever a task matches it, and auto-learn lists your learned skills at the start of each session with what each one is for.

Claude can also save skills on its own during a session with the `manage_skill` tool that the plugin adds.

## Install

```sh
claude plugin marketplace add Yashpal-0/auto-learn
claude plugin install auto-learn@auto-learn
```

Restart running Claude Code sessions afterwards: hooks load when a session starts.

auto-learn needs:

- Node.js 18 or later on `PATH`. The hooks and the MCP server are Node scripts with no dependencies.
- The `claude` command on the `PATH` that Claude Code passes to its hooks. Each review runs `claude` in the background.

## How a review works

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

## License

[MIT](LICENSE)
