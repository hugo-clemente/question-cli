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
