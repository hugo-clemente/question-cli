# question-cli

**A blocking question primitive for coding agents.** Your agent hits a decision it shouldn't make alone — it shells out to `question-cli`, which posts a multiple-choice question to a Discord channel. Humans vote, discuss in an auto-created thread, and a designated owner makes the call. The command blocks until then, and the agent gets the decision — votes, discussion and all — as JSON on stdout.

```
agent ──► question-cli ──► Discord poll + discussion thread
                │                    │ humans vote & talk
                │◄── blocks ─────────┤ owner decides (or deadline)
                ▼
        JSON on stdout ──► agent continues with the answer
```

No webhooks, no server, no state — one process per question.

## Install

```bash
npm install -g question-cli   # or: npx question-cli
export DISCORD_BOT_TOKEN=...
```

## Discord bot setup (once)

1. Create an app at <https://discord.com/developers/applications>, add a bot, copy its token.
2. Invite it with scope `bot` and permissions: **View Channel, Send Messages, Embed Links, Read Message History, Create Public Threads, Send Messages in Threads**.
3. No privileged intents required.

## Usage

Non-interactive — what an agent runs (all flags required when stdin isn't a TTY):

```bash
question ask \
  --channel 123456789012345678 \
  --owner 234567890123456789 \
  --question "Zero-commitment investor — what should the digest do?" \
  --option "Skip them|no row" \
  --option "Include with €0 HT|keeps the list complete" \
  --select single \
  --deadline 2h
```

Interactive — run `question ask` in a terminal and clack prompts fill in whatever flags you omitted.

| Flag                     | Meaning                                                 |
| ------------------------ | ------------------------------------------------------- |
| `--channel <id>`         | target Discord channel ID                               |
| `--owner <userId>`       | the human who can make the final decision               |
| `--question <text>`      | the question (becomes the poll embed)                   |
| `--title <text>`         | discussion-thread name (default: question's first line) |
| `--option "Label\|desc"` | repeatable, 2–25; description optional                  |
| `--select single\|multi` | ballot type (default `single`)                          |
| `--deadline <dur>`       | `90m`, `2h`, `1d` — 1 minute to 7 days (default `24h`)  |
| `--out <file>`           | also write the result JSON to a file                    |

## Output contract

**stdout carries exactly one thing: the result JSON** (one line, on resolution). Everything else — prompts, errors, diagnostics — goes to stderr.

```json
{
  "status": "decided",
  "decision": "B",
  "decidedBy": "234567890123456789",
  "tally": { "A": ["345678901234567890"], "B": ["234567890123456789"] },
  "startedAt": "2026-07-15T09:00:12.000Z",
  "resolvedAt": "2026-07-15T09:41:23.000Z",
  "messageId": "1393112233445566778",
  "channelId": "123456789012345678",
  "threadId": "1393112233445566779",
  "discussion": [
    {
      "userId": "345678901234567890",
      "text": "B, but only if we keep the CSV export",
      "at": "2026-07-15T09:12:41.000Z"
    }
  ],
  "users": {
    "234567890123456789": { "username": "klo", "displayName": "Klo" },
    "345678901234567890": { "username": "sam", "displayName": "Sam" }
  }
}
```

- `status` — `"decided"` (owner picked) or `"expired"` (deadline hit; never auto-picks a winner).
- `decision` — the winning option key (`"A"`, `"B"`, …) or `null` when expired.
- `tally` — option key → array of voter user IDs.
- `discussion` — every human message from the poll's thread, oldest first. Often carries nuance the vote doesn't.
- `users` — user ID → `{ username, displayName }` for everyone who voted, decided, or posted.

On resolution the Discord poll message is replaced with a clean conclusion and the discussion thread is archived.

### Exit codes

| Exit | stdout      | Meaning                                                                                                                          |
| ---- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0    | result JSON | resolved (decided or expired)                                                                                                    |
| 1    | result JSON | resolved, but the `--out` file write failed                                                                                      |
| 1    | empty       | error before resolution: bad flags, missing token, missing permissions, or interrupted (SIGINT/SIGTERM edits the poll to say so) |

**Rule for agents: parse stdout first.** Valid JSON on stdout means the question was resolved, regardless of exit code.

## Teach your agent

Paste into your `CLAUDE.md` / `AGENTS.md` (fill in your channel and owner IDs):

```markdown
## Asking the team

When you hit a product decision, naming choice, or tradeoff you shouldn't make alone,
ask the team on Discord (requires DISCORD_BOT_TOKEN in the environment):

    npx question-cli ask --channel <CHANNEL_ID> --owner <OWNER_ID> \
      --question "<the question, with enough context to answer it>" \
      --option "First choice|one-line implication" \
      --option "Second choice|one-line implication" \
      --deadline 2h

- The command BLOCKS until the owner decides or the deadline passes (up to the
  deadline you set). Run it in the background and continue other work while waiting.
- Parse stdout as JSON: `decision` holds the chosen option key; `tally` who voted
  for what; `discussion` the thread conversation — read it, it often contains
  reasoning or a better third option.
- `"status": "expired"` means nobody decided. Do NOT treat it as approval; pick the
  safest path or ask again with a longer deadline.
```

Or install the ready-made skill straight into your agent ([Claude Code, Cursor, Codex, and 70+ others](https://skills.sh)):

```bash
npx skills add hugo-clemente/question-cli
```

The skill source lives in [`skills/asking-the-team/`](skills/asking-the-team/SKILL.md).

## Development

```bash
pnpm install
pnpm start ask        # run from source
pnpm test             # 38 tests, node:test
pnpm check            # format + lint + typecheck (Vite+)
pnpm build            # bundle to dist/cli.mjs (vp pack)
```

## License

MIT
