import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAborted, renderMessage, renderResolved, customId, parseCustomId } from "../src/render.ts";
import type { PollState } from "../src/poll.ts";

const s: PollState = {
  pollId: "p1",
  question: "Q?",
  ownerUserId: "owner",
  status: "open",
  select: "single",
  deadlineAt: 9_999_999_999_999,
  options: [
    { key: "A", label: "Skip", description: "no row" },
    { key: "B", label: "Keep" },
  ],
  votes: { u1: ["A"] },
  decision: null,
  decidedBy: null,
  startedAt: "2026-07-10T00:00:00Z",
  resolvedAt: null,
};

test("customId round-trips", () => {
  assert.equal(customId("p1", "vote"), "qcli:p1:vote");
  assert.deepEqual(parseCustomId("qcli:p1:vote"), { pollId: "p1", kind: "vote" });
  assert.equal(parseCustomId("nope"), null);
});

test("embed shows voters as mentions in per-option fields", () => {
  const fields = renderMessage(s).embeds[0]!.toJSON().fields ?? [];
  const a = fields.find((f) => f.name.startsWith("A."));
  const b = fields.find((f) => f.name.startsWith("B."));
  assert.match(a!.name, /\(1\)/);        // A has one voter
  assert.match(a!.value, /<@u1>/);       // rendered as a mention
  assert.equal(b!.value, "—");           // B has none
});

test("open render carries ballot + decide selects (no Other button)", () => {
  const m = renderMessage(s);
  const ids = m.components.flatMap((r) => r.components.map((c: any) => c.data.custom_id));
  assert.ok(ids.includes("qcli:p1:vote"));
  assert.ok(ids.includes("qcli:p1:decide"));
  assert.ok(!ids.includes("qcli:p1:other"));
});

test("open render includes the question in the embed description", () => {
  const m = renderMessage(s);
  assert.match(m.embeds[0]!.toJSON().description ?? "", /Q\?/);
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

test("embed description is capped to Discord's 4096 character limit", () => {
  const long: PollState = {
    ...s,
    question: "Q".repeat(2000),
    options: Array.from({ length: 25 }, (_, i) => ({
      key: String.fromCharCode(65 + i),
      label: `L${i}`.padEnd(100, "x"),
      description: `D${i}`.padEnd(100, "y"),
    })),
  };
  const description = renderMessage(long).embeds[0]!.toJSON().description ?? "";
  assert.ok(description.length <= 4096);
});

test("aborted render disables components and says interrupted", () => {
  const m = renderAborted(s);
  assert.match(m.embeds[0]!.toJSON().description ?? "", /Interrupted/);
  for (const row of m.components) for (const c of row.components as any[]) assert.equal(c.toJSON().disabled, true);
});
