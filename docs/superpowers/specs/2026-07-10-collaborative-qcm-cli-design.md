# question-cli - collaborative QCM primitive (v1)

## What this is

A CLI that posts **one** multiple-choice question to a Discord channel, collects
votes through message components, lets a designated **owner** make the final call,
and prints the resolved decision as JSON.

It is the reusable primitive a larger issue-refinement agent can call later. It is
not that agent, not a Discord-native poll, and not a decision algorithm.

Origin: design study "The collaborative QCM"
(artifact `ec67a58b-9f37-4a12-9a2c-f622c4278239`). v1 deliberately narrows that
study. See [Explicitly out of scope](#explicitly-out-of-scope-v1).

## Core principle

Votes **inform**; the owner **decides**. The tool surfaces divergence cheaply and
routes the actual call to one accountable human. It never averages, ranks, or
auto-picks a winner from a split vote.

## Discord constraints that shape the design

These are design inputs, not implementation trivia:

- Every component or modal-submit interaction must receive an initial response
  within Discord's 3 second interaction window. After that, the interaction token
  is invalid.
- Interaction tokens are for interaction responses and followups, and are only
  valid for 15 minutes. Long-running poll state and final message edits must not
  depend on an old interaction token.
- Editing the original poll message is a normal bot-token REST edit of the bot's
  own message. It is not an interaction-token edit.
- A string select menu supports at most 25 options. Each option's `label`,
  `value`, and `description` is capped by Discord's component limits. v1 rejects
  configs that do not fit instead of truncating them.
- Component `custom_id` values are capped at 100 characters. They must be compact
  and namespaced, not a serialized poll.
- Discord components cannot be hidden, disabled, or permissioned per viewer. The
  owner decision control is visible to everyone; authorization happens in the
  interaction handler.
- A modal must be opened as the initial response to the button interaction. The
  adapter must not `deferUpdate()` and then try to show a modal.
- Message edits and channel sends are rate limited. The adapter coalesces visual
  tally edits and respects Discord/discord.js retry handling instead of editing
  the message after every interaction synchronously.
- Component interactions do not require message-content, reaction, or member
  privileged intents. The bot should request the narrowest gateway intent set
  that still lets discord.js receive `interactionCreate` and access guild channel
  metadata.

## Architecture - three isolated units

The decision rules must be testable without Discord. The Discord adapter owns all
network behavior, rendering, rate-limit handling, and acknowledgement timing.

### 1. `poll` core (pure, no discord.js)

A pure state machine over an in-memory poll state:

```ts
type PollStatus = "open" | "decided" | "expired";

type PollState = {
  pollId: string;
  ownerUserId: string;
  status: PollStatus;
  select: "single" | "multi";
  deadlineAt: number;
  options: { key: string; label: string; description?: string }[];
  votes: Record<string, string[]>;
  others: { userId: string; text: string; at: string }[];
  decision: string | null;
  decidedBy: string | null;
  startedAt: string;
  resolvedAt: string | null;
};
```

Core operations:

- `applyVote(state, userId, optionKeys, now)` records or replaces a user's vote.
  One user has one ballot. Re-voting replaces the previous selection. For
  `select: "single"`, `optionKeys` must contain exactly one key. For
  `select: "multi"`, it must contain at least one key and at most the number of
  configured options.
- `applyDecision(state, userId, optionKey, now)` finalizes the poll. It is rejected
  unless `userId === ownerUserId`, the poll is still open, the deadline has not
  passed, and `optionKey` is one of the configured keys.
- `applyOther(state, userId, text, now)` appends a free-text note to `others[]`.
  It is rejected when the poll is closed or expired. It does not change the ballot.
- `expire(state, now)` changes `open` to `expired` when `now >= deadlineAt`; it
  never picks a winner.
- `tally(state)` returns `{ [optionKey]: userId[] }`.
- `result(state, now)` returns the output object without making an implicit owner
  decision.

Rules enforced here:

- Only the owner can decide.
- Deadlines are authoritative: no vote, note, or decision is accepted at or after
  `deadlineAt`.
- Single- vs multi-select validation is independent of Discord UI behavior.
- A user's vote replaces their earlier vote and never double counts.
- Expiry yields `status: "expired"`, `decision: null`, `decidedBy: null`, and the
  full tally.
- User identity in state and output is the Discord user snowflake, not a display
  name or username.

The adapter serializes all calls into this core through one per-poll queue. Even
in Node, async Discord handlers can interleave around REST calls; the state machine
must not rely on handler timing.

### 2. `discord` adapter (thin, over discord.js)

Owns the gateway connection, channel preflight, interaction acknowledgements,
message rendering, and REST failure handling. It holds no decision rules beyond
mapping Discord interactions to core operations.

#### Client and channel preflight

- Create a discord.js client with the minimal required intent set for this flow:
  `GatewayIntentBits.Guilds`. Do not request `MessageContent`, reaction intents,
  or member privileged intents.
- Log in with `DISCORD_BOT_TOKEN`, fetch the configured channel by ID, and reject
  before posting unless the channel is a guild text channel or accessible thread
  that can receive bot messages.
- Required install scope: `bot`. Slash-command scope is not required for this CLI
  because v1 does not register commands.
- Required channel permissions:
  - `ViewChannel`
  - `SendMessages`
  - `EmbedLinks`
  - `SendMessagesInThreads` when the target is a thread
- `ManageMessages` is not required because the bot edits only its own poll message.
- Runtime interactions should also inspect `interaction.appPermissions` where
  available and fail with a clear ephemeral rejection if the bot lost permissions
  after the poll was posted.

#### Rendering

The poll message is one bot-owned message containing an embed plus components.
The message is edited in place as state changes. The **question is rendered in the
embed description**, not the title — a Discord embed title caps at 256 chars while
a question may be up to 2000. The assembled description (question + option lines +
status) is hard-capped at Discord's 4096-char limit (sliced with an ellipsis), so
a valid config can never fail the send; the full option text is always shown
natively in the ballot select regardless.

Component layout:

1. Ballot string select:
   - `custom_id`: `qcli:<pollId>:vote`
   - values: option keys only (`A`, `B`, ...)
   - `min_values: 1`
   - `max_values: 1` for single-select, `options.length` for multi-select
2. Owner decision string select:
   - `custom_id`: `qcli:<pollId>:decide`
   - values: option keys only
   - `min_values: 1`
   - `max_values: 1`
   - visible to everyone; non-owner submissions are rejected in the handler
3. "Other..." button:
   - `custom_id`: `qcli:<pollId>:other`
   - opens a modal with one paragraph text input

This uses three action rows, inside Discord's five-row message-component limit.
Both selects reuse the same option key set, so the 25-option string-select cap is
the v1 maximum ballot size.

Closed polls are rendered by editing the original message with disabled components
and an explicit status line (`decided` or `expired`). The adapter must attempt this
on owner decision and on deadline expiry.

#### Interaction handling

All handlers first parse and validate the `custom_id`. If it does not match this
process's `pollId`, the interaction is ignored so parallel runs using the same bot
token do not acknowledge each other's components.

For interactions matching this poll:

- Ballot select:
  - If closed or expired, reply ephemerally and do not mutate state.
  - Otherwise acknowledge quickly with `deferUpdate()`, enqueue `applyVote`, and
    schedule a coalesced poll-message edit.
- Owner decision select:
  - If `interaction.user.id !== ownerUserId`, reply ephemerally and do not mutate
    state.
  - If closed or expired, reply ephemerally and do not mutate state.
  - Otherwise acknowledge quickly with `deferUpdate()`, enqueue `applyDecision`,
    flush the render queue, disable components, resolve the CLI, and print JSON.
- "Other..." button:
  - If closed or expired, reply ephemerally.
  - Otherwise call `showModal()` as the initial response. Do not defer first.
- Other modal submit:
  - Acknowledge with an ephemeral deferred reply.
  - Enqueue `applyOther`.
  - Send a normal channel message referencing the poll message with
    `allowed_mentions: { parse: [] }`; do not allow free-text notes to ping users.
  - Edit the ephemeral reply to confirm recording.
  - Schedule a coalesced poll-message edit showing the count and recent note
    summary if space allows.

If an accepted interaction races with expiry or decision after its initial ack,
the queued core operation rejects. The adapter sends an ephemeral followup when
the interaction token is still valid and otherwise logs the rejection to stderr.

Ephemeral replies are only user feedback. They are not durable audit records and
must not be included in the result.

#### Render queue and rate limits

Visual tally updates are best-effort and eventually consistent with the in-memory
state:

- Coalesce ordinary vote/note renders with a short debounce, e.g. 750-1000 ms.
- Keep only one in-flight edit of the poll message. If another render is requested
  while an edit is in flight, mark a pending render and send it after the current
  edit settles.
- Let discord.js/REST consume rate-limit headers and retries. Do not hard-code
  route limits.
- Final decision and deadline expiry force a render flush through the same queue,
  but still respect 429 retry instructions.
- A 403 or 404 while editing or sending after the poll was posted is fatal for the
  adapter. The CLI exits non-zero with a diagnostic on stderr and does not claim a
  valid resolved JSON result.

### 3. `cli` entry

- `resolveInput()` produces the config object from flags, prompting with
  `@clack/prompts` for missing values only when stdin is a TTY.
- In a pipe or CI context, missing required fields exit non-zero with a clear
  stderr error. The CLI must never hang waiting for prompts when stdin is not a
  TTY.
- Runtime flow:
  1. validate config and token presence
  2. connect gateway
  3. preflight target channel and permissions
  4. post the poll message
  5. listen until owner decision, deadline expiry, or fatal adapter error
  6. disable components on resolved polls
  7. write `--out` if requested
  8. print one JSON object to stdout
  9. disconnect and exit
- stdout is reserved for the final JSON only. Progress, warnings, permission
  errors, and Discord diagnostics go to stderr.
- Exit code:
  - `0` for `decided`
  - `0` for `expired`
  - non-zero for config, credential, permission, network, deleted-message, or
    interrupted-run errors
- On `SIGINT`/`SIGTERM` after posting, the CLI best-effort edits the poll message
  to disabled/aborted-looking components, prints a diagnostic to stderr, prints no
  result JSON, disconnects, and exits non-zero.

## Input

Two input paths feed one internal config shape.

### Interactive (default, TTY)

`question ask` with missing args prompts for:

- question text
- options, entered as label plus optional description until the user finishes
- channel ID
- owner user ID
- deadline duration
- single- vs multi-select

The prompt path uses the same validation as flags.

### Non-interactive (flags)

Parsed with `node:util.parseArgs` from the standard library.

| flag | meaning |
|---|---|
| `--channel <id>` | target Discord channel snowflake |
| `--owner <userId>` | owner/decider Discord user snowflake |
| `--question <text>` | question text |
| `--option "<label>|<description>"` | repeatable; one per option |
| `--select single|multi` | ballot type, default `single` |
| `--deadline <dur>` | duration such as `24h`, `90m`, default `24h` |
| `--out <file>` | also write the result JSON to this path |
| `--help` | print usage to stdout and exit 0 |

Option keys are assigned by position. Callers do not supply keys.

Validation:

- `--channel` and `--owner` must be Discord snowflake-looking strings.
- `--question` must be 1-2000 characters.
- Option count must be 2-25. Keys are `A` through `Y`.
- Option labels must be 1-100 characters.
- Option descriptions must be 0-100 characters.
- Option values sent to Discord are the generated keys, never labels.
- `--deadline` must be a positive duration from 1 minute through 7 days.
- "Other" note input is capped at 1000 characters in v1 even though Discord text
  inputs allow more.
- No input is silently truncated. Invalid input exits before posting.
- `--out` is written atomically where the filesystem supports rename. On success
  the CLI prints the result JSON to stdout **first**, then writes `--out`; if the
  `--out` write fails, it reports the error on stderr and exits non-zero, but the
  stdout JSON was already emitted (a resolved decision is never discarded over an
  optional-file disk error). Errors *before* a resolution still print no stdout
  JSON. (Revised from the original all-or-nothing rule per an explicit decision —
  the agent-shell-out caller should read stdout regardless of exit code.)

### Internal config shape

```json
{
  "channelId": "123456789012345678",
  "ownerUserId": "234567890123456789",
  "select": "single",
  "deadlineMs": 86400000,
  "question": "An investor has zero commitments this period - what should the digest do?",
  "options": [
    { "key": "A", "label": "Skip them", "description": "No row" },
    { "key": "B", "label": "Include with 0 HT", "description": "Keeps the list complete" },
    { "key": "C", "label": "Separate section", "description": "No activity block at the bottom" }
  ]
}
```

## Result out

JSON to stdout, and to `--out` when requested:

```json
{
  "status": "decided",
  "decision": "A",
  "decidedBy": "234567890123456789",
  "tally": {
    "A": ["111111111111111111", "222222222222222222"],
    "B": ["333333333333333333"],
    "C": []
  },
  "others": [
    {
      "userId": "444444444444444444",
      "text": "0 HT, but only if they committed last period",
      "at": "2026-07-10T09:47:00Z"
    }
  ],
  "messageId": "345678901234567890",
  "channelId": "123456789012345678",
  "startedAt": "2026-07-10T09:42:00Z",
  "resolvedAt": "2026-07-10T09:51:00Z"
}
```

- `status`: `decided` or `expired`
- `decision`: winning option key, or `null` when expired
- `decidedBy`: owner user ID, or `null` when expired
- `tally`: all configured option keys, including empty arrays
- `others`: captured notes with stable user IDs and timestamps

The result deliberately does not include ephemeral rejection messages, display
names, or a computed plurality.

## Runtime model

One Node process owns one active poll. State lives in memory. Discord stores the
message and delivers component interactions, but it does not store the tool's vote
state.

If the process dies mid-poll, vote state is lost and stale components may remain
on the Discord message until manually cleaned up or the poll is re-run. Users
clicking stale components will see Discord's generic interaction failure because
there is no live process to acknowledge them. That is accepted v1 behavior under
the crash-resume scope cut.

Parallel CLI runs with the same bot token are allowed only because every component
is namespaced by a random `pollId`. A process must ignore `qcli` interactions for
other poll IDs and must never acknowledge them.

## Credentials

`DISCORD_BOT_TOKEN` env var is required. Missing token exits before connecting.
Invalid token exits before posting. Permission failures exit before posting when
detected by preflight.

The bot invite should request the `bot` scope and the channel permissions listed
in [Client and channel preflight](#client-and-channel-preflight). v1 does not need
application commands, message content, reaction events, or privileged member data.

## Testing

The `poll` core is pure and carries assert-based self-checks covering:

- re-vote replaces, not doubles
- single-select rejects multi-key votes
- multi-select rejects empty and over-wide votes
- unknown option keys are rejected
- non-owner `applyDecision` is rejected
- owner decision after deadline is rejected
- vote and Other after decision are rejected
- deadline expiry yields `expired` with `decision: null`, `decidedBy: null`, and
  the full tally
- result output uses user IDs, not display names

The CLI validation self-checks cover:

- non-TTY missing required fields exit instead of prompting
- option count above 25 is rejected before posting
- label, description, question, deadline, channel ID, and owner ID limits
- stdout remains JSON-only for resolved polls

The Discord adapter is manually exercised against a real test channel in v1:

- vote select records and re-votes
- multi-select records multiple keys
- non-owner decision receives only an ephemeral rejection
- owner decision resolves and disables components
- Other opens a modal without deferring first
- Other note is posted visibly with mentions suppressed
- deadline expiry disables components and prints expired JSON
- deleted poll message or lost send/edit permission exits non-zero

## Explicitly out of scope (v1)

Each is a later, separate concern. The boundary is explicit so v1 stays a small
primitive:

- **Crash-resume.** Votes are in-memory; a dead process means re-run. Snapshotting
  votes to a JSON file keyed by `messageId` plus `--resume` belongs in a later
  change. Mark the state boundary with a `ponytail:` comment.
- **Ballot growth / "Other" promotion.** v1's "Other" is a captured note only; the
  ballot is fixed. This drops the design study's headline move on purpose.
- **LLM classification** of Other answers (rephrase/new/question).
- **Slack adapter**, **Linear write-back**, **ambiguity detection** - the
  surrounding refinement agent.
- **stdin-JSON input** escape hatch - repeatable `--option` covers the agent case;
  add stdin JSON only if flag-building proves painful.
