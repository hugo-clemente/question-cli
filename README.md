# question-cli

Post one collaborative multiple-choice question to a Discord channel, collect votes,
let a designated owner make the call, and get the decision back as JSON.

## Setup

```bash
pnpm install
export DISCORD_BOT_TOKEN=...   # bot needs: View Channel, Send Messages, Embed Links; Send Messages in Threads for threads
```

Bot invite scope: `bot`. No privileged intents required.

## Use

Interactive:

```bash
pnpm start ask
```

Non-interactive (what an agent shells out to):

```bash
node --import tsx src/cli.ts ask \
  --channel 123... --owner 234... \
  --question "Zero-commitment investor — what should the digest do?" \
  --option "Skip them|no row" \
  --option "Include €0 HT|keeps the list complete" \
  --select single --deadline 24h --out result.json
```

Result (stdout, JSON only):

```json
{
  "status": "decided",
  "decision": "A",
  "decidedBy": "234...",
  "tally": { "A": ["u1"], "B": [] },
  "others": [],
  "messageId": "…",
  "channelId": "…",
  "startedAt": "…",
  "resolvedAt": "…"
}
```

`status` is `decided` or `expired` (deadline hit with no owner decision — never auto-picks).

**Read stdout regardless of exit code.** On success the CLI prints the result JSON to stdout and exits 0. If `--out` is given and its file write fails _after_ the poll resolved, the CLI still prints the result JSON to stdout, reports the file error on stderr, and exits non-zero — so a non-zero exit with valid JSON on stdout means "resolved, but couldn't write `--out`." Errors before a resolution (bad config, missing token, interrupt) print no stdout JSON.
