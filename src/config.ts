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
  if (!m) throw new Error(`invalid deadline "${text}" - use e.g. 24h, 90m, or 7d`);

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

  const select: Select =
    raw.select === "multi"
      ? "multi"
      : raw.select === undefined || raw.select === "single"
        ? "single"
        : (() => {
            throw new Error('select must be "single" or "multi"');
          })();

  const question = (raw.question ?? "").trim();
  if (question.length < 1 || question.length > 2000) throw new Error("question must be 1-2000 characters");

  const opts = raw.options ?? [];
  if (opts.length < 2 || opts.length > 25) throw new Error("need between 2 and 25 options");
  for (const o of opts) {
    if (o.label.length < 1 || o.label.length > 100) {
      throw new Error(`option label "${o.label}" must be 1-100 characters`);
    }
    if ((o.description ?? "").length > 100) throw new Error("option description must be 0-100 characters");
  }

  return {
    channelId,
    ownerUserId,
    select,
    deadlineMs: parseDuration(raw.deadline ?? "24h"),
    question,
    options: assignKeys(opts),
  };
}
