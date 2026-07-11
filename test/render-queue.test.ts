import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderQueue } from "../src/render-queue.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("schedule coalesces many requests into one debounced edit", async () => {
  let edits = 0;
  const q = createRenderQueue(async () => { edits += 1; }, 5);
  q.schedule();
  q.schedule();
  q.schedule();
  await sleep(20);
  assert.equal(edits, 1);
});

test("flush waits for an in-flight edit and sends a pending latest edit", async () => {
  let release!: () => void;
  const calls: string[] = [];
  const q = createRenderQueue(async () => {
    calls.push(`edit-${calls.length + 1}`);
    if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  }, 5);

  q.schedule();
  await sleep(20);
  assert.deepEqual(calls, ["edit-1"]);

  q.schedule();
  release();
  await q.flush();

  assert.deepEqual(calls, ["edit-1", "edit-2"]);
});
