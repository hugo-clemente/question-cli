# Collaborative QCM CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI that posts one multiple-choice question to a Discord channel, collects votes via interactive components, lets a designated owner decide, and prints the resolved decision as JSON.

**Architecture:** Three isolated units plus a pure renderer. `poll` core is a pure state machine (no I/O) holding all decision rules. `render` is a pure function turning poll state into Discord message payloads. `render-queue` is a small tested scheduler used by the Discord adapter to coalesce edits without stale overwrites. `discord` owns the gateway, interaction acks, bot-token message edits, abort cleanup, deadline timer, and the per-poll mutation queue. `cli` resolves input (flags via stdlib, prompts via clack) and runs one poll to completion.

**Tech Stack:** Node 20+ (ESM), TypeScript, `discord.js` v14, `@clack/prompts`, `node:util.parseArgs` (flags), `node:test` + `node:assert` (tests), `tsx` (run TS), `tsc` (typecheck only).

## Global Constraints

- Node **>= 20** (stable `parseArgs`, `node:test`, `--import`); `"type": "module"`, ESM only.
- Pin `discord.js` to a Node-20-compatible v14 line. Do not upgrade to the moving `main`/latest release without re-checking the package `engines.node` floor.
- Only two runtime deps: `discord.js`, `@clack/prompts`. No commander/yargs/jest/vitest/dotenv.
- Credentials: `DISCORD_BOT_TOKEN` env var. Missing → exit non-zero before connecting.
- Gateway intents: **`GatewayIntentBits.Guilds` only** — never MessageContent/reaction/member intents.
- **stdout carries the final JSON result and nothing else.** All progress/warnings/errors → stderr.
- Component `custom_id` format: `qcli:<pollId>:<vote|decide|other>`. Process ignores IDs for other pollIds.
- Option ballot cap: **2–25 options**, keys assigned by position `A`..`Y`. No silent truncation — invalid config exits before posting.
- Limits: question 1–2000 chars; option label 1–100; option description 0–100; Other note ≤1000; deadline 1 min–7 days.
- Exit `0` for both `decided` and `expired`; non-zero for config/credential/permission/network/deleted-message/interrupted errors.
- Owner decision is a **separate, everyone-visible** string select gated in the handler (Discord can't permission components per viewer).
- User identity everywhere is the Discord snowflake, never a display name.
- Tally edits are **coalesced** (debounce, one in-flight edit); live message edited via bot-token REST, never a stale interaction token.
- Spec: `docs/superpowers/specs/2026-07-10-collaborative-qcm-cli-design.md`.

## File Structure

- `package.json` — deps, scripts (`test`, `typecheck`, `start`), `bin`, Node engine floor.
- `tsconfig.json` — strict, NodeNext, ES2022, `noEmit` (tsx runs; tsc only typechecks).
- `.gitignore`, `.env.example`, `README.md`.
- `src/poll.ts` — pure state machine: types + `applyVote`/`applyDecision`/`applyOther`/`expire`/`tally`/`result`/`isResolved`.
- `src/config.ts` — `Config`/`Option` types + `validateConfig` + `parseDuration` + `assignKeys`.
- `src/input.ts` — `resolveInput(argv, isTTY)` → `{ config, out }`; flags via `parseArgs`, clack prompts for missing when TTY.
- `src/render.ts` — pure `renderMessage(state)` / `renderResolved(state)` / `renderAborted(state)` → `{ embeds, components }`.
- `src/render-queue.ts` — tested debounce/flush scheduler used by `discord.ts`.
- `src/discord.ts` — `runPoll(config, token, signal?)` adapter: gateway, preflight, post, interaction queue, debounced edits, deadline timer, abort cleanup.
- `src/cli.ts` — entry (`#!/usr/bin/env -S node --import tsx`): resolve input/help → token check → runPoll → optional atomic `--out` → print JSON → exit.
- `test/poll.test.ts`, `test/config.test.ts`, `test/input.test.ts`, `test/render.test.ts`, `test/render-queue.test.ts`.

---

### Task 1: Project scaffold + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `test/.gitkeep`

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm test` (runs `node --import tsx --test` over explicit `.ts` test paths from `find`), `pnpm typecheck` (`tsc --noEmit`).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "question-cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "question": "./src/cli.ts" },
  "engines": { "node": ">=20" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test $(find test -name '*.test.ts' -type f | sort)",
    "start": "node --import tsx src/cli.ts"
  },
  "dependencies": {
    "@clack/prompts": "^0.7.0",
    "discord.js": "14.16.3"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `.gitignore`, `.env.example`, and `test/.gitkeep`**

`.gitignore`:
```
node_modules
*.log
.env
```

`.env.example`:
```
DISCORD_BOT_TOKEN=your-bot-token-here
```

`test/.gitkeep`: empty file so `find test ...` works before the first real test exists.

- [ ] **Step 4: Install deps**

Run: `pnpm install`
Expected: lockfile written, `node_modules` populated, no peer-dep errors.

- [ ] **Step 5: Verify tooling runs**

Run: `pnpm typecheck`
Expected: exit 0 (no source yet, nothing to check → passes).
Run: `pnpm test`
Expected: exit 0 with `1..0` / zero tests. The script intentionally uses `find` instead of a shell glob because zsh rejects unmatched `test/*.test.ts`, and Node 20 does not auto-discover `.ts` tests unless they are passed explicitly.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example test/.gitkeep pnpm-lock.yaml
git commit -m "chore: scaffold TypeScript CLI project"
```

---

### Task 2: `poll` core — state + `applyVote`

**Files:**
- Create: `src/poll.ts`
- Test: `test/poll.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types `PollStatus = "open"|"decided"|"expired"`, `Select = "single"|"multi"`, `Option = {key:string;label:string;description?:string}`, `PollState`, `OpResult = {ok:true}|{ok:false;reason:string}`.
  - `applyVote(s: PollState, userId: string, keys: string[], now: number): OpResult`.

- [ ] **Step 1: Write the failing test**

```ts
// test/poll.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVote, type PollState } from "../src/poll.ts";

function baseState(over: Partial<PollState> = {}): PollState {
  return {
    pollId: "p1", question: "Q?", ownerUserId: "owner", status: "open", select: "single",
    deadlineAt: 1000, options: [{ key: "A", label: "A" }, { key: "B", label: "B" }],
    votes: {}, others: [], decision: null, decidedBy: null,
    startedAt: "2026-07-10T00:00:00Z", resolvedAt: null, ...over,
  };
}

test("re-vote replaces, not doubles", () => {
  const s = baseState();
  assert.deepEqual(applyVote(s, "u1", ["A"], 0), { ok: true });
  assert.deepEqual(applyVote(s, "u1", ["B"], 0), { ok: true });
  assert.deepEqual(s.votes["u1"], ["B"]);
});

test("single-select rejects multi-key votes", () => {
  const s = baseState();
  assert.equal(applyVote(s, "u1", ["A", "B"], 0).ok, false);
});

test("multi-select rejects empty and over-wide votes", () => {
  const s = baseState({ select: "multi" });
  assert.equal(applyVote(s, "u1", [], 0).ok, false);
  assert.equal(applyVote(s, "u1", ["A", "B", "A"], 0).ok, true); // dedup -> [A,B]
  assert.deepEqual(s.votes["u1"], ["A", "B"]);
});

test("unknown option key is rejected", () => {
  const s = baseState();
  assert.equal(applyVote(s, "u1", ["Z"], 0).ok, false);
});

test("vote at/after deadline is rejected", () => {
  const s = baseState();
  assert.equal(applyVote(s, "u1", ["A"], 1000).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/poll.test.ts`
Expected: FAIL — cannot find module `../src/poll.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/poll.ts
export type PollStatus = "open" | "decided" | "expired";
export type Select = "single" | "multi";
export type Option = { key: string; label: string; description?: string };

export type PollState = {
  pollId: string;
  question: string;
  ownerUserId: string;
  status: PollStatus;
  select: Select;
  deadlineAt: number;
  options: Option[];
  votes: Record<string, string[]>;
  others: { userId: string; text: string; at: string }[];
  decision: string | null;
  decidedBy: string | null;
  startedAt: string;
  resolvedAt: string | null;
};

export type OpResult = { ok: true } | { ok: false; reason: string };
const ok = (): OpResult => ({ ok: true });
const err = (reason: string): OpResult => ({ ok: false, reason });

const knows = (s: PollState, key: string) => s.options.some((o) => o.key === key);

export function applyVote(s: PollState, userId: string, keys: string[], now: number): OpResult {
  if (s.status !== "open") return err("poll not open");
  if (now >= s.deadlineAt) return err("deadline passed");
  const deduped = [...new Set(keys)];
  if (deduped.length === 0) return err("no option selected");
  if (!deduped.every((k) => knows(s, k))) return err("unknown option");
  if (s.select === "single" && deduped.length !== 1) return err("single-select needs exactly one");
  if (s.select === "multi" && deduped.length > s.options.length) return err("too many options");
  s.votes[userId] = deduped;
  return ok();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/poll.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/poll.ts test/poll.test.ts
git commit -m "feat: poll core state and applyVote"
```

---

### Task 3: `poll` core — decision, other, expire, tally, result

**Files:**
- Modify: `src/poll.ts`
- Test: `test/poll.test.ts` (add cases)

**Interfaces:**
- Consumes: `PollState`, `OpResult` from Task 2.
- Produces:
  - `applyDecision(s, userId, key, now): OpResult`
  - `applyOther(s, userId, text, now): OpResult`
  - `expire(s, now): void`
  - `isResolved(s, now): boolean`
  - `tally(s): Record<string,string[]>`
  - `result(s): PollResult` where `PollResult = { status:"decided"|"expired"; decision:string|null; decidedBy:string|null; tally:Record<string,string[]>; others:PollState["others"]; startedAt:string; resolvedAt:string|null }`

- [ ] **Step 1: Write the failing tests (append)**

```ts
// append to test/poll.test.ts
import { applyDecision, applyOther, expire, isResolved, tally, result } from "../src/poll.ts";

test("non-owner applyDecision is rejected", () => {
  const s = baseState();
  assert.equal(applyDecision(s, "u1", "A", 0).ok, false);
  assert.equal(s.status, "open");
});

test("owner decision after deadline is rejected", () => {
  const s = baseState();
  assert.equal(applyDecision(s, "owner", "A", 1000).ok, false);
});

test("owner decides and closes with resolvedAt", () => {
  const s = baseState();
  assert.deepEqual(applyDecision(s, "owner", "A", 500), { ok: true });
  assert.equal(s.status, "decided");
  assert.equal(s.decision, "A");
  assert.equal(s.decidedBy, "owner");
  assert.equal(s.resolvedAt, new Date(500).toISOString());
});

test("vote and Other after decision are rejected", () => {
  const s = baseState();
  applyDecision(s, "owner", "A", 0);
  assert.equal(applyVote(s, "u1", ["B"], 0).ok, false);
  assert.equal(applyOther(s, "u1", "hi", 0).ok, false);
});

test("Other rejects empty and over-limit text", () => {
  const s = baseState();
  assert.equal(applyOther(s, "u1", "", 0).ok, false);
  assert.equal(applyOther(s, "u1", "x".repeat(1001), 0).ok, false);
  assert.deepEqual(applyOther(s, "u1", "valid note", 0), { ok: true });
  assert.equal(s.others[0]!.text, "valid note");
});

test("expiry yields expired with nulls and full tally", () => {
  const s = baseState();
  applyVote(s, "u1", ["A"], 0);
  expire(s, 1000);
  assert.equal(s.status, "expired");
  const r = result(s);
  assert.equal(r.status, "expired");
  assert.equal(r.decision, null);
  assert.equal(r.decidedBy, null);
  assert.deepEqual(r.tally, { A: ["u1"], B: [] });
});

test("tally includes empty option arrays and uses user ids", () => {
  const s = baseState();
  applyVote(s, "111", ["A"], 0);
  assert.deepEqual(tally(s), { A: ["111"], B: [] });
});

test("isResolved true on decision or past deadline", () => {
  const s = baseState();
  assert.equal(isResolved(s, 0), false);
  assert.equal(isResolved(s, 1000), true);
  applyDecision(s, "owner", "A", 0);
  assert.equal(isResolved(s, 0), true);
});

test("expire never overrides an owner decision", () => {
  const s = baseState();
  applyDecision(s, "owner", "A", 500);
  expire(s, 1000);
  assert.equal(s.status, "decided");
  assert.equal(s.decision, "A");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/poll.test.ts`
Expected: FAIL — `applyDecision` etc. not exported.

- [ ] **Step 3: Write minimal implementation (append to `src/poll.ts`)**

```ts
export function applyDecision(s: PollState, userId: string, key: string, now: number): OpResult {
  if (userId !== s.ownerUserId) return err("not owner");
  if (s.status !== "open") return err("poll not open");
  if (now >= s.deadlineAt) return err("deadline passed");
  if (!knows(s, key)) return err("unknown option");
  s.status = "decided";
  s.decision = key;
  s.decidedBy = userId;
  s.resolvedAt = new Date(now).toISOString();
  return ok();
}

export function applyOther(s: PollState, userId: string, text: string, now: number): OpResult {
  if (s.status !== "open") return err("poll not open");
  if (now >= s.deadlineAt) return err("deadline passed");
  const clean = text.trim();
  if (!clean) return err("empty note");
  if (clean.length > 1000) return err("note too long");
  s.others.push({ userId, text: clean, at: new Date(now).toISOString() });
  return ok();
}

export function expire(s: PollState, now: number): void {
  if (s.status === "open" && now >= s.deadlineAt) {
    s.status = "expired";
    s.resolvedAt = new Date(now).toISOString();
  }
}

export function isResolved(s: PollState, now: number): boolean {
  return s.status === "decided" || now >= s.deadlineAt;
}

export function tally(s: PollState): Record<string, string[]> {
  const t: Record<string, string[]> = {};
  for (const o of s.options) t[o.key] = [];
  for (const [uid, keys] of Object.entries(s.votes)) {
    for (const k of keys) t[k]?.push(uid);
  }
  return t;
}

export type PollResult = {
  status: "decided" | "expired";
  decision: string | null;
  decidedBy: string | null;
  tally: Record<string, string[]>;
  others: PollState["others"];
  startedAt: string;
  resolvedAt: string | null;
};

export function result(s: PollState): PollResult {
  return {
    status: s.status === "decided" ? "decided" : "expired",
    decision: s.decision,
    decidedBy: s.decidedBy,
    tally: tally(s),
    others: s.others,
    startedAt: s.startedAt,
    resolvedAt: s.resolvedAt,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/poll.test.ts`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/poll.ts test/poll.test.ts
git commit -m "feat: poll core decision, other, expire, tally, result"
```

---

### Task 4: `config` — types, validation, duration, keys

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `Option`, `Select` from `src/poll.ts`.
- Produces:
  - `Config = { channelId:string; ownerUserId:string; select:Select; deadlineMs:number; question:string; options:Option[] }`
  - `RawConfig = { channelId?:string; ownerUserId?:string; select?:string; deadline?:string; question?:string; options?:{label:string;description?:string}[] }`
  - `parseDuration(text: string): number` (ms; throws `Error` on invalid/out-of-range)
  - `assignKeys(opts: {label:string;description?:string}[]): Option[]` (keys A..Y by position)
  - `validateConfig(raw: RawConfig): Config` (throws `Error` with a user-facing message on any violation)

- [ ] **Step 1: Write the failing tests**

```ts
// test/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration, assignKeys, validateConfig, type RawConfig } from "../src/config.ts";

test("parseDuration handles m, h, and d within 1min..7d", () => {
  assert.equal(parseDuration("24h"), 24 * 3600_000);
  assert.equal(parseDuration("90m"), 90 * 60_000);
  assert.equal(parseDuration("7d"), 7 * 24 * 3600_000);
  assert.throws(() => parseDuration("0m"));
  assert.throws(() => parseDuration("8d"));
  assert.throws(() => parseDuration("banana"));
});

test("assignKeys assigns A.. by position", () => {
  const keys = assignKeys([{ label: "x" }, { label: "y" }]).map((o) => o.key);
  assert.deepEqual(keys, ["A", "B"]);
});

const good: RawConfig = {
  channelId: "123456789012345678", ownerUserId: "234567890123456789",
  select: "single", deadline: "24h", question: "Q?",
  options: [{ label: "Skip" }, { label: "Keep", description: "all" }],
};

test("validateConfig accepts a good config", () => {
  const c = validateConfig(good);
  assert.equal(c.deadlineMs, 24 * 3600_000);
  assert.equal(c.options.length, 2);
  assert.equal(c.options[1]!.key, "B");
});

test("validateConfig rejects <2 or >25 options", () => {
  assert.throws(() => validateConfig({ ...good, options: [{ label: "only" }] }));
  const many = Array.from({ length: 26 }, (_, i) => ({ label: `o${i}` }));
  assert.throws(() => validateConfig({ ...good, options: many }));
});

test("validateConfig rejects non-snowflake ids and bad lengths", () => {
  assert.throws(() => validateConfig({ ...good, channelId: "abc" }));
  assert.throws(() => validateConfig({ ...good, question: "" }));
  assert.throws(() => validateConfig({ ...good, options: [{ label: "" }, { label: "b" }] }));
  assert.throws(() => validateConfig({ ...good, options: [{ label: "a", description: "x".repeat(101) }, { label: "b" }] }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/config.ts
import type { Option, Select } from "./poll.ts";

export type RawConfig = {
  channelId?: string;
  ownerUserId?: string;
  select?: string;
  deadline?: string;
  question?: string;
  options?: { label: string; description?: string }[];
};

export type Config = {
  channelId: string;
  ownerUserId: string;
  select: Select;
  deadlineMs: number;
  question: string;
  options: Option[];
};

const SNOWFLAKE = /^\d{17,20}$/;
const MIN_MS = 60_000;
const MAX_MS = 7 * 24 * 3600_000;

export function parseDuration(text: string): number {
  const m = /^(\d+)([mhd])$/.exec(text.trim());
  if (!m) throw new Error(`invalid deadline "${text}" — use e.g. 24h, 90m, or 7d`);
  const n = Number(m[1]);
  const ms = m[2] === "d" ? n * 24 * 3600_000 : m[2] === "h" ? n * 3600_000 : n * 60_000;
  if (ms < MIN_MS || ms > MAX_MS) throw new Error("deadline must be between 1 minute and 7 days");
  return ms;
}

export function assignKeys(opts: { label: string; description?: string }[]): Option[] {
  return opts.map((o, i) => ({ key: String.fromCharCode(65 + i), label: o.label, description: o.description }));
}

export function validateConfig(raw: RawConfig): Config {
  const channelId = raw.channelId ?? "";
  const ownerUserId = raw.ownerUserId ?? "";
  if (!SNOWFLAKE.test(channelId)) throw new Error("channel must be a Discord ID (17-20 digits)");
  if (!SNOWFLAKE.test(ownerUserId)) throw new Error("owner must be a Discord user ID (17-20 digits)");

  const select: Select = raw.select === "multi" ? "multi" : raw.select === undefined || raw.select === "single"
    ? "single"
    : (() => { throw new Error('select must be "single" or "multi"'); })();

  const question = (raw.question ?? "").trim();
  if (question.length < 1 || question.length > 2000) throw new Error("question must be 1-2000 characters");

  const opts = raw.options ?? [];
  if (opts.length < 2 || opts.length > 25) throw new Error("need between 2 and 25 options");
  for (const o of opts) {
    if (o.label.length < 1 || o.label.length > 100) throw new Error(`option label "${o.label}" must be 1-100 characters`);
    if ((o.description ?? "").length > 100) throw new Error("option description must be 0-100 characters");
  }

  return { channelId, ownerUserId, select, deadlineMs: parseDuration(raw.deadline ?? "24h"), question, options: assignKeys(opts) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/config.ts test/config.test.ts
git commit -m "feat: config validation, duration parsing, key assignment"
```

---

### Task 5: `input` — resolveInput (flags + clack)

**Files:**
- Create: `src/input.ts`
- Test: `test/input.test.ts`

**Interfaces:**
- Consumes: `validateConfig`, `RawConfig`, `Config` from `src/config.ts`.
- Produces: `resolveInput(argv: string[], isTTY: boolean): Promise<{ config: Config; out?: string }>`.
  - Non-TTY: builds `RawConfig` from flags only; missing required field → throws before any prompt.
  - TTY: prompts (clack) for each missing field, then validates.
  - Optional subcommand `ask` is accepted and ignored; any other positional is rejected.
  - `--option` is repeatable, format `"label|description"` (split on first `|`).
  - `--help` throws `HelpRequested` carrying `usage`; `cli.ts` is responsible for printing to stdout and exiting 0.

- [ ] **Step 1: Write the failing tests**

```ts
// test/input.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { HelpRequested, resolveInput } from "../src/input.ts";

const flags = [
  "ask",
  "--channel", "123456789012345678",
  "--owner", "234567890123456789",
  "--question", "Q?",
  "--option", "Skip|no row",
  "--option", "Keep",
  "--deadline", "12h",
  "--out", "/tmp/r.json",
];

test("non-TTY full flags produce a valid config", async () => {
  const { config, out } = await resolveInput(flags, false);
  assert.equal(config.channelId, "123456789012345678");
  assert.equal(config.options[0]!.label, "Skip");
  assert.equal(config.options[0]!.description, "no row");
  assert.equal(config.options[1]!.description, undefined);
  assert.equal(config.deadlineMs, 12 * 3600_000);
  assert.equal(out, "/tmp/r.json");
});

test("non-TTY missing required field throws instead of prompting", async () => {
  await assert.rejects(resolveInput(["--channel", "123456789012345678"], false));
});

test("unknown positional is rejected", async () => {
  await assert.rejects(resolveInput(["nope", ...flags.slice(1)], false), /unknown positional/);
});

test("--help is testable and does not exit inside resolveInput", async () => {
  await assert.rejects(
    resolveInput(["--help"], false),
    (err) => err instanceof HelpRequested && err.usage.includes("question ask"),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/input.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/input.ts
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { validateConfig, type Config, type RawConfig } from "./config.ts";

export const USAGE = `question ask — post a collaborative multiple-choice question to Discord

Flags:
  --channel <id>            target Discord channel ID
  --owner <userId>          the decider's Discord user ID
  --question <text>         the question
  --option "<label>|<desc>" repeatable; 2-25 options (desc optional)
  --select single|multi     ballot type (default single)
  --deadline <dur>          e.g. 24h, 90m (default 24h)
  --out <file>              also write result JSON here
  --help                    show this help

Env: DISCORD_BOT_TOKEN (required)`;

export class HelpRequested extends Error {
  readonly usage: string;
  constructor(usage = USAGE) {
    super("help requested");
    this.name = "HelpRequested";
    this.usage = usage;
  }
}

function splitOption(s: string): { label: string; description?: string } {
  const i = s.indexOf("|");
  if (i === -1) return { label: s };
  return { label: s.slice(0, i), description: s.slice(i + 1) };
}

const options = {
  channel: { type: "string" },
  owner: { type: "string" },
  question: { type: "string" },
  option: { type: "string", multiple: true },
  select: { type: "string" },
  deadline: { type: "string" },
  out: { type: "string" },
  help: { type: "boolean" },
} as const;

function stringValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`--${name} must be a string`);
}

function stringArrayValue(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new Error(`--${name} must be provided as one or more strings`);
}

export async function resolveInput(argv: string[], isTTY: boolean): Promise<{ config: Config; out?: string }> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options,
  });

  if (values.help) throw new HelpRequested();
  if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== "ask")) {
    throw new Error(`unknown positional argument: ${positionals.join(" ")}`);
  }

  const raw: RawConfig = {
    channelId: stringValue(values.channel, "channel"),
    ownerUserId: stringValue(values.owner, "owner"),
    question: stringValue(values.question, "question"),
    select: stringValue(values.select, "select"),
    deadline: stringValue(values.deadline, "deadline"),
    options: stringArrayValue(values.option, "option")?.map(splitOption),
  };

  if (isTTY) await promptMissing(raw);

  // validateConfig throws a user-facing Error for any missing/invalid field.
  return { config: validateConfig(raw), out: stringValue(values.out, "out") };
}

async function promptMissing(raw: RawConfig): Promise<void> {
  const ask = async (label: string, current?: string): Promise<string> => {
    if (current) return current;
    const v = await p.text({ message: label });
    if (p.isCancel(v)) { p.cancel("cancelled"); process.exit(1); }
    return v as string;
  };

  raw.question ??= await ask("Question");
  raw.channelId ??= await ask("Channel ID");
  raw.ownerUserId ??= await ask("Owner user ID");

  if (!raw.options || raw.options.length === 0) {
    const opts: { label: string; description?: string }[] = [];
    for (;;) {
      const label = await p.text({ message: `Option ${opts.length + 1} label (empty to finish)` });
      if (p.isCancel(label)) { p.cancel("cancelled"); process.exit(1); }
      if (!label) break;
      const desc = await p.text({ message: "  description (optional)" });
      if (p.isCancel(desc)) { p.cancel("cancelled"); process.exit(1); }
      opts.push({ label: label as string, description: (desc as string) || undefined });
    }
    raw.options = opts;
  }

  if (!raw.select) {
    const sel = await p.select({
      message: "Ballot type",
      options: [{ value: "single", label: "single-select" }, { value: "multi", label: "multi-select" }],
    });
    if (p.isCancel(sel)) { p.cancel("cancelled"); process.exit(1); }
    raw.select = sel as string;
  }

  raw.deadline ??= (await ask("Deadline (e.g. 24h)")) || "24h";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/input.test.ts`
Expected: PASS (all tests; the non-TTY path never touches clack).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/input.ts test/input.test.ts
git commit -m "feat: input resolution via flags and clack prompts"
```

---

### Task 6: `render` — pure Discord message payload

**Files:**
- Create: `src/render.ts`
- Test: `test/render.test.ts`

**Interfaces:**
- Consumes: `PollState`, `tally` from `src/poll.ts`.
- Produces:
  - `renderMessage(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }` (open poll: ballot select + owner-decide select + Other button).
  - `renderResolved(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }` (disabled components + status line).
  - `renderAborted(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] }` (disabled components + aborted status; used only for SIGINT cleanup, never for result JSON).
  - `customId(pollId: string, kind: "vote"|"decide"|"other"): string` → `qcli:<pollId>:<kind>`.
  - `parseCustomId(id: string): { pollId: string; kind: string } | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAborted, renderMessage, renderResolved, customId, parseCustomId } from "../src/render.ts";
import type { PollState } from "../src/poll.ts";

const s: PollState = {
  pollId: "p1", question: "Q?", ownerUserId: "owner", status: "open", select: "single",
  deadlineAt: 9_999_999_999_999, options: [{ key: "A", label: "Skip", description: "no row" }, { key: "B", label: "Keep" }],
  votes: { u1: ["A"] }, others: [], decision: null, decidedBy: null,
  startedAt: "2026-07-10T00:00:00Z", resolvedAt: null,
};

test("customId round-trips", () => {
  assert.equal(customId("p1", "vote"), "qcli:p1:vote");
  assert.deepEqual(parseCustomId("qcli:p1:vote"), { pollId: "p1", kind: "vote" });
  assert.equal(parseCustomId("nope"), null);
});

test("open render carries ballot + decide selects and an Other button", () => {
  const m = renderMessage(s);
  const ids = m.components.flatMap((r) => r.components.map((c: any) => c.data.custom_id));
  assert.ok(ids.includes("qcli:p1:vote"));
  assert.ok(ids.includes("qcli:p1:decide"));
  assert.ok(ids.includes("qcli:p1:other"));
});

test("ballot select uses option keys as values, min 1", () => {
  const m = renderMessage(s);
  const vote: any = m.components[0]!.components[0];
  const json = vote.toJSON();
  assert.deepEqual(json.options.map((o: any) => o.value), ["A", "B"]);
  assert.equal(json.min_values, 1);
  assert.equal(json.max_values, 1);
});

test("resolved render disables every component", () => {
  const decided: PollState = { ...s, status: "decided", decision: "A", decidedBy: "owner" };
  const m = renderResolved(decided);
  for (const row of m.components) for (const c of row.components as any[]) assert.equal(c.toJSON().disabled, true);
});

test("decision select labels do not exceed Discord's 100 char cap", () => {
  const long: PollState = { ...s, options: [{ key: "A", label: "x".repeat(100) }, { key: "B", label: "y" }] };
  const decide: any = renderMessage(long).components[1]!.components[0];
  assert.equal(decide.toJSON().options[0].label.length, 100);
});

test("aborted render disables components and says interrupted", () => {
  const m = renderAborted(s);
  assert.match(m.embeds[0]!.toJSON().description ?? "", /Interrupted/);
  for (const row of m.components) for (const c of row.components as any[]) assert.equal(c.toJSON().disabled, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/render.ts
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from "discord.js";
import { tally, type PollState } from "./poll.ts";

export function customId(pollId: string, kind: "vote" | "decide" | "other"): string {
  return `qcli:${pollId}:${kind}`;
}

export function parseCustomId(id: string): { pollId: string; kind: string } | null {
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "qcli") return null;
  return { pollId: parts[1]!, kind: parts[2]! };
}

function embed(s: PollState, overrideStatus?: string): EmbedBuilder {
  const t = tally(s);
  const lines = s.options.map((o) => `**${o.key}.** ${o.label}${o.description ? ` — ${o.description}` : ""}  ·  \`${t[o.key]!.length}\``);
  const statusLine =
    overrideStatus ? `\n\n${overrideStatus}`
    : s.status === "decided" ? `\n\n✅ **Decided: ${s.decision}** by <@${s.decidedBy}>`
    : s.status === "expired" ? `\n\n⏳ **Expired** — no decision`
    : `\n\n<@${s.ownerUserId}> decides · closes <t:${Math.floor(s.deadlineAt / 1000)}:R>`;
  return new EmbedBuilder().setTitle(s.question).setDescription(lines.join("\n") + statusLine);
}

function ballotSelect(s: PollState): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(customId(s.pollId, "vote"))
    .setPlaceholder("Vote…")
    .setMinValues(1)
    .setMaxValues(s.select === "multi" ? s.options.length : 1)
    .addOptions(s.options.map((o) => {
      const opt = new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.key);
      if (o.description) opt.setDescription(o.description.slice(0, 100));
      return opt;
    }));
}

function decideSelect(s: PollState): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(customId(s.pollId, "decide"))
    .setPlaceholder("Owner: decide…")
    .setMinValues(1).setMaxValues(1)
    .addOptions(s.options.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.key)));
}

function otherButton(s: PollState): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId(s.pollId, "other")).setLabel("Other…").setStyle(ButtonStyle.Secondary);
}

export function renderMessage(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  return {
    embeds: [embed(s)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(ballotSelect(s)),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(decideSelect(s)),
      new ActionRowBuilder<ButtonBuilder>().addComponents(otherButton(s)),
    ],
  };
}

export function renderResolved(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  const m = renderMessage(s);
  for (const row of m.components) for (const c of row.components) (c as any).setDisabled(true);
  return m;
}

export function renderAborted(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  const m = {
    embeds: [embed(s, "Interrupted — this local CLI run stopped before producing a result.")],
    components: renderMessage(s).components,
  };
  for (const row of m.components) for (const c of row.components) (c as any).setDisabled(true);
  return m;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/render.ts test/render.test.ts
git commit -m "feat: pure Discord message rendering"
```

---

### Task 7: `discord` adapter — gateway, preflight, interactions, queue

**Files:**
- Create: `src/render-queue.ts`
- Create: `src/discord.ts`
- Test: `test/render-queue.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/config.ts`); `PollState`/`applyVote`/`applyDecision`/`applyOther`/`expire`/`isResolved`/`result`/`PollResult` (`src/poll.ts`); `renderMessage`/`renderResolved`/`renderAborted`/`parseCustomId` (`src/render.ts`).
- Produces: `createRenderQueue(edit, debounceMs)` and `runPoll(config: Config, token: string, signal?: AbortSignal): Promise<PollResult & { messageId: string; channelId: string }>`.
  - Resolves when the owner decides, the deadline expires, or a fatal adapter error occurs (rejects on fatal errors and on config/permission failures found in preflight).
  - Rejects with `"interrupted"` after best-effort disabled/aborted message cleanup when `signal` aborts after posting.

> The live gateway path is still manually verified in Task 8, but the render debounce/flush behavior is automated here because it is easy to regress and does not require Discord.

- [ ] **Step 1: Write failing render queue tests**

```ts
// test/render-queue.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderQueue } from "../src/render-queue.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("schedule coalesces many requests into one debounced edit", async () => {
  let edits = 0;
  const q = createRenderQueue(async () => { edits += 1; }, 5);
  q.schedule();
  q.schedule();
  q.schedule();
  await sleep(20);
  assert.equal(edits, 1);
});

test("flush waits for an in-flight edit and sends a pending latest edit", async () => {
  let release!: () => void;
  const calls: string[] = [];
  const q = createRenderQueue(async () => {
    calls.push(`edit-${calls.length + 1}`);
    if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  }, 5);

  q.schedule();
  await sleep(20);
  assert.deepEqual(calls, ["edit-1"]);

  q.schedule();
  release();
  await q.flush();

  assert.deepEqual(calls, ["edit-1", "edit-2"]);
});
```

- [ ] **Step 2: Implement `src/render-queue.ts`**

```ts
// src/render-queue.ts
export type RenderQueue = {
  schedule(): void;
  flush(): Promise<void>;
  cancel(): void;
};

export function createRenderQueue(edit: () => Promise<void>, debounceMs: number): RenderQueue {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let pending = false;

  const run = async (): Promise<void> => {
    do {
      pending = false;
      await edit();
    } while (pending);
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = true;

    if (inFlight) {
      await inFlight;
      if (!pending) return;
    }

    inFlight = run();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  return {
    schedule() {
      pending = true;
      if (timer || inFlight) return;
      timer = setTimeout(() => {
        timer = null;
        void flush().catch(() => undefined);
      }, debounceMs);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
    },
  };
}
```

- [ ] **Step 3: Run queue tests to verify they pass**

Run: `node --import tsx --test test/render-queue.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Write the adapter**

```ts
// src/discord.ts
import {
  Client, GatewayIntentBits, Events, ChannelType, MessageFlags, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  type Interaction, type Message, type SendableChannels, type User,
} from "discord.js";
import { randomUUID } from "node:crypto";
import {
  applyVote, applyDecision, applyOther, expire, isResolved, result,
  type PollState, type PollResult,
} from "./poll.ts";
import { renderAborted, renderMessage, renderResolved, parseCustomId } from "./render.ts";
import { createRenderQueue } from "./render-queue.ts";
import type { Config } from "./config.ts";

const RENDER_DEBOUNCE_MS = 800;
type RunResult = PollResult & { messageId: string; channelId: string };
type PermissionLike = { has(bit: bigint): boolean };
type PermissionedSendable = SendableChannels & {
  permissionsFor?: (target: unknown) => PermissionLike | null;
  isThread?: () => boolean;
};

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral });

function isSendableTextChannel(ch: unknown): ch is SendableChannels {
  return Boolean(
    ch &&
    typeof ch === "object" &&
    "isTextBased" in ch &&
    typeof ch.isTextBased === "function" &&
    ch.isTextBased() &&
    "send" in ch &&
    typeof ch.send === "function",
  );
}

function assertGuildChannel(ch: SendableChannels): void {
  if ("type" in ch && (ch.type === ChannelType.DM || ch.type === ChannelType.GroupDM)) {
    throw new Error("target must be a guild channel or thread, not a DM");
  }
  if (!("guild" in ch)) throw new Error("target must be a guild channel or thread");
}

function assertChannelPermissions(ch: SendableChannels, user: User): void {
  const c = ch as PermissionedSendable;
  const perms = c.permissionsFor?.(user);
  if (!perms) return;
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  if (c.isThread?.()) required.push(PermissionFlagsBits.SendMessagesInThreads);
  const missing = required.filter((bit) => !perms.has(bit));
  if (missing.length > 0) throw new Error("bot is missing required channel permissions");
}

function hasRuntimePermissions(interaction: Interaction): boolean {
  return interaction.appPermissions.has(PermissionFlagsBits.ViewChannel) &&
    interaction.appPermissions.has(PermissionFlagsBits.SendMessages) &&
    interaction.appPermissions.has(PermissionFlagsBits.EmbedLinks);
}

export function runPoll(config: Config, token: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const now = () => Date.now();
    const pollId = randomUUID().slice(0, 8);
    const state: PollState = {
      pollId, question: config.question, ownerUserId: config.ownerUserId, status: "open", select: config.select,
      deadlineAt: 0, options: config.options,
      votes: {}, others: [], decision: null, decidedBy: null,
      startedAt: "", resolvedAt: null,
    };

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    let channel: SendableChannels | null = null;
    let message: Message | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let closing = false;
    let completed = false;

    // ponytail: in-memory state only; crash mid-poll => re-run. Snapshot+--resume is the documented upgrade path.
    let mutationQueue = Promise.resolve();
    const enqueue = <T>(fn: () => T | Promise<T>): Promise<T> => {
      const run = mutationQueue.then(fn, fn);
      mutationQueue = run.then(() => undefined, () => undefined);
      return run;
    };

    const renderQueue = createRenderQueue(async () => {
      if (!message) return;
      try {
        const payload = closing || state.status !== "open" ? renderResolved(state) : renderMessage(state);
        await message.edit(payload);
      } catch (e) {
        fatal(e);
        throw e;
      }
    }, RENDER_DEBOUNCE_MS);

    const clearDeadline = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };

    const fatal = (e: unknown) => {
      if (completed) return;
      completed = true;
      closing = true;
      clearDeadline();
      renderQueue.cancel();
      signal?.removeEventListener("abort", onAbort);
      void client.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    const finishResolved = async () => {
      if (completed || closing) return;
      closing = true;
      clearDeadline();
      try {
        await renderQueue.flush();
      } catch {
        return;
      }
      if (!message) return fatal(new Error("poll message was not posted"));
      completed = true;
      signal?.removeEventListener("abort", onAbort);
      const out = { ...result(state), messageId: message.id, channelId: config.channelId };
      await client.destroy();
      resolve(out);
    };

    const abortPoll = async () => {
      if (completed || closing) return;
      closing = true;
      clearDeadline();
      renderQueue.cancel();
      try {
        if (message) await message.edit(renderAborted(state));
      } catch {
        // Best-effort cleanup only. The CLI still exits non-zero and prints no JSON.
      }
      completed = true;
      signal?.removeEventListener("abort", onAbort);
      await client.destroy();
      reject(new Error("interrupted"));
    };

    function onAbort() {
      void abortPoll();
    }

    client.once(Events.ClientReady, async () => {
      try {
        const ch = await client.channels.fetch(config.channelId);
        if (!isSendableTextChannel(ch)) throw new Error("channel is not a sendable text channel");
        assertGuildChannel(ch);
        assertChannelPermissions(ch, client.user!);
        channel = ch;
        const started = now();
        state.startedAt = new Date(started).toISOString();
        state.deadlineAt = started + config.deadlineMs;
        message = await channel.send(renderMessage(state));
        deadlineTimer = setTimeout(() => {
          void enqueue(() => {
            if (completed || closing) return false;
            expire(state, now());
            return state.status === "expired";
          }).then((expired) => {
            if (expired) void finishResolved();
          }).catch(fatal);
        }, Math.max(0, state.deadlineAt - now()));
      } catch (e) {
        fatal(e);
      }
    });

    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      const id = "customId" in interaction ? interaction.customId : "";
      const parsed = id ? parseCustomId(id) : null;
      if (!parsed || parsed.pollId !== pollId) return; // ignore other polls / stray interactions

      try {
        if (!interaction.isRepliable()) return;
        if (completed || closing) {
          await interaction.reply(ephemeral("This poll is closed."));
          return;
        }
        if (!hasRuntimePermissions(interaction)) {
          await interaction.reply(ephemeral("The bot no longer has the channel permissions needed for this poll."));
          return;
        }

        if (interaction.isStringSelectMenu() && parsed.kind === "vote") {
          if (isResolved(state, now())) {
            await interaction.reply(ephemeral("This poll is closed."));
            return;
          }
          await interaction.deferUpdate();
          const r = await enqueue(() => applyVote(state, interaction.user.id, interaction.values, now()));
          if (r.ok) renderQueue.schedule();
          else await interaction.followUp(ephemeral(`Vote not recorded: ${r.reason}`));
        } else if (interaction.isStringSelectMenu() && parsed.kind === "decide") {
          if (interaction.user.id !== config.ownerUserId) {
            await interaction.reply(ephemeral("Only the owner can decide this poll."));
            return;
          }
          if (isResolved(state, now())) {
            await interaction.reply(ephemeral("This poll is closed."));
            return;
          }
          const key = interaction.values[0]!;
          await interaction.deferUpdate();
          const r = await enqueue(() => applyDecision(state, interaction.user.id, key, now()));
          if (!r.ok) {
            await interaction.followUp(ephemeral(`Decision not recorded: ${r.reason}`));
            return;
          }
          await finishResolved();
        } else if (interaction.isButton() && parsed.kind === "other") {
          if (isResolved(state, now())) {
            await interaction.reply(ephemeral("This poll is closed."));
            return;
          }
          const modal = new ModalBuilder().setCustomId(`qcli:${pollId}:othermodal`).setTitle("Other answer")
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("text").setLabel("Your answer (a note for the owner)")
                .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)));
          await interaction.showModal(modal); // must be the initial response — never defer first
        } else if (interaction.isModalSubmit() && parsed.kind === "othermodal") {
          const text = interaction.fields.getTextInputValue("text");
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const r = await runOther(interaction.user.id, text);
          if (r.ok) {
            if (!channel) throw new Error("channel unavailable");
            try {
              await channel.send({ content: `Other from <@${interaction.user.id}> on the poll: ${text}`, allowedMentions: { parse: [] } });
            } catch (e) {
              fatal(e);
              return;
            }
            renderQueue.schedule();
          }
          await interaction.editReply(r.ok ? "Noted." : `Not recorded: ${r.reason}`);
        }
      } catch (e) {
        console.error("interaction error:", e instanceof Error ? e.message : e);
      }
    });

    async function runOther(userId: string, text: string) {
      let r = { ok: false, reason: "unknown" } as ReturnType<typeof applyOther>;
      await enqueue(() => { r = applyOther(state, userId, text, now()); });
      return r;
    }

    if (signal?.aborted) {
      void abortPoll();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    client.login(token).catch(fatal);
  });
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0 with the adapter code above. The message edit path is `message.edit(...)`, not `channel.messages.edit`, so `SendableChannels` is only used for `send`.

- [ ] **Step 6: Commit**

```bash
git add src/render-queue.ts src/discord.ts test/render-queue.test.ts
git commit -m "feat: discord adapter — gateway, interactions, coalesced renders"
```

---

### Task 8: `cli` entry + README + manual verification

**Files:**
- Create: `src/cli.ts`, `README.md`

**Interfaces:**
- Consumes: `resolveInput` (`src/input.ts`), `runPoll` (`src/discord.ts`).
- Produces: the executable CLI. No further consumers.

- [ ] **Step 1: Write `src/cli.ts`**

```ts
#!/usr/bin/env -S node --import tsx
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { HelpRequested, resolveInput } from "./input.ts";
import { runPoll } from "./discord.ts";

type ResolvedInput = Awaited<ReturnType<typeof resolveInput>>;

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    throw e;
  }
}

async function main(): Promise<void> {
  let resolved: ResolvedInput;
  try {
    resolved = await resolveInput(process.argv.slice(2), Boolean(process.stdin.isTTY));
  } catch (e) {
    if (e instanceof HelpRequested) {
      process.stdout.write(e.usage + "\n");
      return;
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("DISCORD_BOT_TOKEN is required");
    process.exit(1);
  }

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const result = await runPoll(resolved.config, token, ac.signal);
    if (resolved.out) writeJsonAtomic(resolved.out, result);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    console.error(ac.signal.aborted ? "interrupted" : e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

void main();
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 3: Write `README.md`**

````markdown
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
pnpm start ask \
  --channel 123... --owner 234... \
  --question "Zero-commitment investor — what should the digest do?" \
  --option "Skip them|no row" \
  --option "Include €0 HT|keeps the list complete" \
  --select single --deadline 24h --out result.json
```

Result (stdout, JSON only):
```json
{ "status": "decided", "decision": "A", "decidedBy": "234...", "tally": { "A": ["u1"], "B": [] }, "others": [], "messageId": "…", "channelId": "…", "startedAt": "…", "resolvedAt": "…" }
```

`status` is `decided` or `expired` (deadline hit with no owner decision — never auto-picks).
````

- [ ] **Step 4: Run the full test suite + typecheck**

Run: `pnpm test`
Expected: PASS — all poll/config/input/render/render-queue tests.
Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Manual verification against a real test channel**

Create a bot, invite it to a test guild channel, `export DISCORD_BOT_TOKEN`, then run the non-interactive command above against that channel with your own user ID as `--owner` and a short `--deadline 2m`. Confirm each:

- [ ] Poll message posts with an embed, a vote select, an owner-decide select, and an "Other…" button.
- [ ] Voting from a non-owner account records and updates the tally (after the ~800 ms debounce).
- [ ] Re-voting replaces the prior choice (count doesn't double).
- [ ] Multi-select run (`--select multi`) records multiple keys.
- [ ] A non-owner using the decide select gets an ephemeral "only the owner can decide" and nothing changes.
- [ ] "Other…" opens a modal (no defer first); submitting posts a visible note with no pings, and an ephemeral "Noted".
- [ ] Owner using the decide select resolves the poll, disables components, prints `decided` JSON to stdout, and exits 0.
- [ ] A separate run left until the 2 min deadline prints `expired` JSON with `decision: null` and exits 0.
- [ ] Pressing Ctrl-C after the poll posts edits the poll message to disabled/interrupted state, prints no stdout JSON, and exits non-zero.
- [ ] Pointing `--channel` at a channel the bot can't see exits non-zero with a clear stderr message and prints no stdout JSON.
- [ ] `pnpm start ask --help` prints usage and exits 0; stdout contains only usage text.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts README.md
git commit -m "feat: CLI entry, README, manual verification checklist"
```

---

## Self-Review

**Spec coverage:**
- Core principle (owner decides, never auto-picks) → Task 3 (`applyDecision`, `expire`, `result`) + tests.
- Three isolated units + pure renderer → Tasks 2/3 (poll), 6 (render), 7 (discord), 5 (input), 8 (cli).
- Discord constraints (3s ack, no stale tokens, per-viewer visibility, select limits, min intents, coalesced edits, modal-as-initial-response, final render flush) → Task 7 adapter + render-queue tests + Global Constraints; option/limit caps → Task 4.
- Input: flags (`parseArgs`) + clack, TTY-gated, non-TTY-missing-exits → Task 5.
- Result JSON shape + stdout purity + `--out` atomic write + exit codes → Task 8.
- Testing (pure core self-checks, input/render checks, render queue checks, adapter manual) → Tasks 2–7 tests + Task 8 Step 5.
- Out-of-scope cuts (crash-resume `ponytail:` marker, no ballot growth, no LLM, no Slack/Linear, no stdin-JSON) → honored; crash-resume marker in Task 7 adapter step.

**Placeholder scan:** No placeholders. The flagged `applyVoteNow` double-apply is removed instead of documented as a later cleanup step.

**Type consistency:** `OpResult`, `PollState`, `PollResult`, `Config`, `Option`, `Select` names match across tasks. `PollState.question` is defined before render consumes it. `customId`/`parseCustomId` shared by render + adapter. `runPoll` return type (`PollResult & { messageId; channelId }`) plus optional `AbortSignal` matches `cli.ts` usage and the spec's result shape.
