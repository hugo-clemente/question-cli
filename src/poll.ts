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
