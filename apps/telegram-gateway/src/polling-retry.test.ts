import assert from "node:assert/strict";
import test from "node:test";

import { computePollingRetryDelayMs, isTelegramPollingConflictError } from "./polling-retry.js";

test("detects polling conflict from telegram error code", () => {
  assert.equal(isTelegramPollingConflictError({ error_code: 409 }), true);
});

test("detects polling conflict from telegram description text", () => {
  assert.equal(
    isTelegramPollingConflictError({
      description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"
    }),
    true
  );
});

test("returns false for unrelated errors", () => {
  assert.equal(isTelegramPollingConflictError({ error_code: 429, description: "Too Many Requests" }), false);
  assert.equal(isTelegramPollingConflictError(new Error("fetch failed")), false);
});

test("computes bounded exponential polling retry delays", () => {
  assert.equal(computePollingRetryDelayMs(1, 1_000, 30_000), 1_000);
  assert.equal(computePollingRetryDelayMs(2, 1_000, 30_000), 2_000);
  assert.equal(computePollingRetryDelayMs(5, 1_000, 30_000), 16_000);
  assert.equal(computePollingRetryDelayMs(6, 1_000, 30_000), 30_000);
  assert.equal(computePollingRetryDelayMs(20, 1_000, 30_000), 30_000);
});
