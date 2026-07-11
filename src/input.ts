import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { validateConfig, type Config, type RawConfig } from "./config.ts";

export const USAGE = `question ask - post a collaborative multiple-choice question to Discord

Flags:
  --channel <id>            target Discord channel ID
  --owner <userId>          the decider's Discord user ID
  --question <text>         the question
  --title <text>            short title for the discussion thread (default: question's first line)
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

const options = {
  channel: { type: "string" },
  owner: { type: "string" },
  question: { type: "string" },
  title: { type: "string" },
  option: { type: "string", multiple: true },
  select: { type: "string" },
  deadline: { type: "string" },
  out: { type: "string" },
  help: { type: "boolean" },
} as const;

function splitOption(value: string): { label: string; description?: string } {
  const index = value.indexOf("|");
  if (index === -1) return { label: value };
  return { label: value.slice(0, index), description: value.slice(index + 1) };
}

function stringValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`--${name} must be a string`);
}

function stringArrayValue(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
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
    title: stringValue(values.title, "title"),
    select: stringValue(values.select, "select"),
    deadline: stringValue(values.deadline, "deadline"),
    options: stringArrayValue(values.option, "option")?.map(splitOption),
  };

  if (isTTY) await promptMissing(raw);

  return { config: validateConfig(raw), out: stringValue(values.out, "out") };
}

async function promptMissing(raw: RawConfig): Promise<void> {
  const ask = async (message: string, current?: string): Promise<string> => {
    if (current) return current;
    const value = await p.text({ message });
    if (p.isCancel(value)) {
      p.cancel("cancelled");
      process.exit(1);
    }
    return value;
  };

  raw.question ??= await ask("Question");

  if (raw.title === undefined) {
    const title = await p.text({ message: "Thread title (optional — defaults to the question's first line)" });
    if (p.isCancel(title)) {
      p.cancel("cancelled");
      process.exit(1);
    }
    if (title) raw.title = title;
  }

  raw.channelId ??= await ask("Channel ID");
  raw.ownerUserId ??= await ask("Owner user ID");

  if (!raw.options || raw.options.length === 0) {
    const promptedOptions: { label: string; description?: string }[] = [];
    for (;;) {
      const label = await p.text({ message: `Option ${promptedOptions.length + 1} label (empty to finish)` });
      if (p.isCancel(label)) {
        p.cancel("cancelled");
        process.exit(1);
      }
      if (!label) break;

      const description = await p.text({ message: "Description (optional)" });
      if (p.isCancel(description)) {
        p.cancel("cancelled");
        process.exit(1);
      }
      promptedOptions.push({ label, description: description || undefined });
    }
    raw.options = promptedOptions;
  }

  if (!raw.select) {
    const select = await p.select({
      message: "Ballot type",
      options: [
        { value: "single", label: "single-select" },
        { value: "multi", label: "multi-select" },
      ],
    });
    if (p.isCancel(select)) {
      p.cancel("cancelled");
      process.exit(1);
    }
    raw.select = select as string;
  }

  raw.deadline ??= (await ask("Deadline (e.g. 24h)")) || "24h";
}
