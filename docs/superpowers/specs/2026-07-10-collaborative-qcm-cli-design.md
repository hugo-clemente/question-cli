# question-cli — collaborative QCM primitive (v1)

## What this is

A CLI that posts **one** multiple-choice question to a Discord channel, collects
votes via interactive components, lets a designated **owner** make the final call,
and prints the resolved decision as JSON. It is the reusable primitive a larger
issue-refinement agent will call later — not the agent itself.

Origin: design study "The collaborative QCM"
(artifact `ec67a58b-9f37-4a12-9a2c-f622c4278239`). v1 deliberately narrows that
study — see [Explicitly out of scope](#explicitly-out-of-scope-v1).

## Core principle

Votes **inform**; the owner **decides**. The tool surfaces divergence cheaply and
routes the actual call to one accountable human. It is not a decision algorithm and
never averages or auto-picks a winner from a split.

## Architecture — three isolated units

The decision rules must be testable without Discord, so the pure logic is separated
from the I/O.

### 1. `poll` core (pure, no discord.js)

A state machine over an in-memory poll state. No network, no side effects.

- `applyVote(state, userId, optionKeys)` — record/replace a user's vote. One vote
  per user; re-voting **replaces** the prior selection. `optionKeys` is an array;
  for `select: "single"` it must contain exactly one key.
- `applyDecision(state, userId, optionKey)` — finalize. Rejected unless
  `userId === ownerId`. Sets status `decided`.
- `applyOther(state, userId, text)` — append a free-text note to `others[]`. Does
  **not** change the ballot (no promotion in v1).
- `isResolved(state, now)` — true if status is `decided`, or `now >= deadline`.
- `tally(state)` — `{ [optionKey]: userId[] }`.
- `result(state, now)` — the output object (see [Result out](#result-out)).

Rules enforced here:
- Only the owner can decide.
- Single- vs multi-select validation.
- A user's vote replaces their earlier vote (no double counting).
- Deadline expiry → `status: "expired"`, `decision: null`, full tally returned.
  **Never** auto-picks the plurality.

### 2. `discord` adapter (thin, over discord.js)

Owns the Discord gateway connection and all rendering. Holds no decision logic.

- Posts the question message: an embed (question + options with descriptions + live
  tally) plus components:
  - a **string select menu** — the ballot (options carry per-option descriptions).
  - an **"Other…"** button → opens a modal with a text input.
  - a **"Decide"** control usable only by the owner (owner picks the winning key).
- Translates incoming interactions into `poll` core calls:
  - select submit → `applyVote`
  - Decide (owner) → `applyDecision`
  - Other modal submit → `applyOther` + post the note visibly under the poll
- Re-renders the tally by **editing** the original message after each state change
  (editing a bot's own message is a plain REST call, unaffected by interaction-token
  expiry).
- Non-owner interactions on the Decide control are rejected with an ephemeral reply.

Interaction acks: every interaction is acknowledged within Discord's 3s window
(`deferUpdate` where no immediate visible change, else `update`).

### 3. `cli` entry

- `resolveInput()` — produce the config object from flags, prompting (via clack) for
  whatever is missing **only when stdin is a TTY**. In a pipe with a missing required
  field → exit non-zero with a clear error; never hang on a prompt.
- Runs the process: connect gateway → post → listen until `isResolved` → print
  `result` JSON to stdout (and to `--out <file>` if given) → disconnect → exit 0.
- Exit code: `0` for `decided`, `0` for `expired` (expiry is a normal outcome, not an
  error — the caller inspects `status`). Config/credential errors exit non-zero.

## Input

Two paths, one internal config shape.

### Interactive (default, TTY)

`question ask` with missing args drops into `@clack/prompts`:
- text: the question
- loop: add options (label + description), finish when done
- select/text: channel id, owner user id, deadline, single-vs-multi

### Non-interactive (flags)

Parsed with `node:util.parseArgs` (stdlib — no commander/yargs).

| flag | meaning |
|---|---|
| `--channel <id>` | target Discord channel |
| `--owner <userId>` | the decider |
| `--question <text>` | the question |
| `--option "<label>\|<description>"` | repeatable; one per option (min 2) |
| `--select single\|multi` | ballot type (default `single`) |
| `--deadline <dur>` | e.g. `24h`, `90m` (default `24h`) |
| `--out <file>` | also write result JSON here |

Option keys (A, B, C…) are assigned by position; callers don't supply them.

### Internal config shape (the contract between `cli` and the other units)

```json
{
  "channelId": "…",
  "ownerUserId": "…",
  "select": "single",
  "deadlineMs": 86400000,
  "question": "An investor has zero commitments this period — what should the digest do?",
  "options": [
    { "key": "A", "label": "Skip them", "description": "No row" },
    { "key": "B", "label": "Include with €0 HT", "description": "Keeps the list complete" },
    { "key": "C", "label": "Separate section", "description": "'No activity' block at the bottom" }
  ]
}
```

## Result out

JSON to stdout (and `--out` if provided):

```json
{
  "status": "decided",
  "decision": "A",
  "decidedBy": "…ownerUserId",
  "tally": { "A": ["u1", "u2"], "B": ["u3"], "C": [] },
  "others": [ { "user": "marie", "text": "€0 but only if they committed last period" } ],
  "messageId": "…",
  "startedAt": "2026-07-10T09:42:00Z",
  "resolvedAt": "2026-07-10T09:51:00Z"
}
```

- `status`: `decided` | `expired`
- `decision`: winning option key, or `null` when `expired`
- `decidedBy`: owner user id, or `null` when `expired`

## Runtime

One long-running Node process holding the Discord gateway websocket for the voting
window. It is meant to be run wherever is convenient — including a remote box — so a
laptop being closed doesn't matter (the process, not the laptop, must stay up).

Because votes come through interactive components (not reactions), Discord stores no
vote state; state lives in this process. If the process dies mid-poll, in-flight vote
state is lost and the poll is re-run. See out-of-scope for the resume path.

## Credentials

`DISCORD_BOT_TOKEN` env var. The bot needs permission to post in the channel, send
components, and open modals. Missing/invalid token → exit non-zero before posting.

## Testing

The `poll` core is the only non-trivial logic and is pure, so it carries an
assert-based self-check covering:
- re-vote replaces, not doubles
- single-select rejects multi-key votes
- non-owner `applyDecision` is rejected
- deadline expiry yields `expired` with `decision: null` and the full tally

The `discord` adapter and `cli` wiring are exercised manually against a real test
channel (no Discord mock in v1).

## Explicitly out of scope (v1)

Each is a later, separate concern — listed so the boundary is unambiguous:

- **Crash-resume.** Votes are in-memory; a dead process means re-run. Snapshotting
  votes to a JSON file keyed by `messageId` (+ `--resume`) is ~a dozen lines — add it
  the first time a real run actually dies. Marked with a `ponytail:` comment at the
  state boundary.
- **Ballot growth / "Other" promotion.** v1's "Other" is a captured note only; the
  ballot is fixed. (This drops the design study's headline move on purpose.)
- **LLM classification** of Other answers (rephrase/new/question).
- **Slack adapter**, **Linear write-back**, **ambiguity detection** — the surrounding
  refinement agent.
- **stdin-JSON input** escape hatch — repeatable `--option` covers the agent case;
  add if flag-building proves painful.
```
