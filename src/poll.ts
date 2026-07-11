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
