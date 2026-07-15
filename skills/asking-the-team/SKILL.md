---
name: asking-the-team
description: Use when facing a product decision, naming choice, or tradeoff a human should make — posts a multiple-choice question to the team's Discord, blocks until the owner decides, and returns the decision with votes and discussion as JSON.
---

# Asking the Team

Post a question to the team's Discord channel with `question-cli` and wait for a human decision. Requires the `DISCORD_BOT_TOKEN` environment variable in the shell you run the command from (the CLI reads it automatically), plus the channel and owner IDs (project config or ask the user once).

**Never handle the token value directly** — don't ask the user to paste it into the conversation, and don't write it into files or commands as a literal. If the CLI exits with `Discord bot token required`, ask the user to export `DISCORD_BOT_TOKEN` in their environment and retry.

## When to reach for this

- A decision changes user-facing behavior and the requirements don't settle it
- Two viable designs with real tradeoffs — the choice is taste or product direction, not correctness
- Anything you were about to guess on that is expensive to undo

Do NOT use it for decisions the code or docs already answer, or for pure implementation details.

## How

```bash
npx question-cli ask \
  --channel <CHANNEL_ID> \
  --owner <OWNER_USER_ID> \
  --question "<question with enough context that someone on their phone can answer>" \
  --option "First choice|one-line implication" \
  --option "Second choice|one-line implication" \
  --deadline 2h
```

- 2–25 options; `--select multi` allows picking several; `--deadline` accepts `30m`, `2h`, `1d` (max `7d`).
- The command **blocks** until the owner decides or the deadline passes. Run it in the background and continue other work; check the result when it exits.

## Reading the result

Parse stdout as JSON (valid JSON on stdout = resolved, regardless of exit code):

- `decision` — winning option key (`"A"`, `"B"`, …), or `null` if expired
- `tally` — option key → voter user IDs; `users` maps IDs to names
- `discussion` — every message from the poll's thread, oldest first. **Always read it**: humans put reasoning, caveats, and better third options there, not in the vote.
- `"status": "expired"` — nobody decided. Not approval. Take the safest path or re-ask with a longer deadline.

Empty stdout + exit 1 = the question never resolved (bad flags, missing token or permissions, interrupt) — fix the cause; nothing was decided.
