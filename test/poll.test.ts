import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDecision,
  applyVote,
  expire,
  isResolved,
  result,
  tally,
  type PollState,
} from "../src/poll.ts";

function baseState(over: Partial<PollState> = {}): PollState {
  return {
    pollId: "p1", question: "Q?", ownerUserId: "owner", status: "open", select: "single",
    deadlineAt: 1000, options: [{ key: "A", label: "A" }, { key: "B", label: "B" }],
    votes: {}, decision: null, decidedBy: null,
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

test("vote after decision is rejected", () => {
  const s = baseState();
  applyDecision(s, "owner", "A", 0);
  assert.equal(applyVote(s, "u1", ["B"], 0).ok, false);
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

test("owner decision with an unknown key is rejected", () => {
  const s = baseState();
  assert.equal(applyDecision(s, "owner", "Z", 0).ok, false);
  assert.equal(s.status, "open");
  assert.equal(s.decision, null);
});

test("a second decision on an already-decided poll is rejected", () => {
  const s = baseState();
  applyDecision(s, "owner", "A", 0);
  assert.equal(applyDecision(s, "owner", "B", 0).ok, false);
  assert.equal(s.decision, "A");
});
