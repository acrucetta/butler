import assert from "node:assert/strict";
import test from "node:test";
import { startTypingIndicator } from "./typing-indicator.js";

test("disabled typing indicator does not tick", async () => {
  let calls = 0;
  const handle = startTypingIndicator({
    enabled: false,
    intervalMs: 10,
    tick: () => {
      calls += 1;
    }
  });

  await sleep(30);
  handle.stop();
  assert.equal(calls, 0);
});

test("typing indicator ticks immediately and stops cleanly", async () => {
  let calls = 0;
  const handle = startTypingIndicator({
    enabled: true,
    intervalMs: 20,
    tick: () => {
      calls += 1;
    }
  });

  await sleep(65);
  handle.stop();
  const countAfterStop = calls;
  await sleep(35);

  assert.ok(countAfterStop >= 1);
  assert.equal(calls, countAfterStop);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
