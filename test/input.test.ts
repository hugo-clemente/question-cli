import { test } from "node:test";
import assert from "node:assert/strict";
import { HelpRequested, resolveInput } from "../src/input.ts";

const flags = [
  "ask",
  "--channel",
  "123456789012345678",
  "--owner",
  "234567890123456789",
  "--question",
  "Q?",
  "--option",
  "Skip|no row",
  "--option",
  "Keep",
  "--deadline",
  "12h",
  "--out",
  "/tmp/r.json",
];

test("non-TTY full flags produce a valid config", async () => {
  const { config, out, token } = await resolveInput(flags, false);
  assert.equal(config.channelId, "123456789012345678");
  assert.equal(config.options[0]!.label, "Skip");
  assert.equal(config.options[0]!.description, "no row");
  assert.equal(config.options[1]!.description, undefined);
  assert.equal(config.deadlineMs, 12 * 3600_000);
  assert.equal(out, "/tmp/r.json");
  assert.equal(token, undefined);
});

test("--token is passed through", async () => {
  const { token } = await resolveInput([...flags, "--token", "abc.def.ghi"], false);
  assert.equal(token, "abc.def.ghi");
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
