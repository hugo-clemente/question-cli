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
  channelId: "123456789012345678",
  ownerUserId: "234567890123456789",
  select: "single",
  deadline: "24h",
  question: "Q?",
  options: [{ label: "Skip" }, { label: "Keep", description: "all" }],
};

test("validateConfig accepts a good config", () => {
  const c = validateConfig(good);
  assert.equal(c.deadlineMs, 24 * 3600_000);
  assert.equal(c.options.length, 2);
  assert.equal(c.options[1]!.key, "B");
});

test("title defaults to the question's first line, sliced to 100", () => {
  assert.equal(validateConfig({ ...good, question: "A clean title\n\nlong body here" }).title, "A clean title");
  assert.equal(validateConfig({ ...good, question: "x".repeat(200) }).title.length, 100);
});

test("explicit title is used and length-validated", () => {
  assert.equal(validateConfig({ ...good, title: "My Title" }).title, "My Title");
  assert.throws(() => validateConfig({ ...good, title: "x".repeat(101) }));
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
  assert.throws(() =>
    validateConfig({ ...good, options: [{ label: "a", description: "x".repeat(101) }, { label: "b" }] }),
  );
});
