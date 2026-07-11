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
