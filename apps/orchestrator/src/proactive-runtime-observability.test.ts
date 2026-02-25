import assert from "node:assert/strict";
import test from "node:test";
import { computeMissedCronWindows } from "./proactive-runtime.js";

test("computeMissedCronWindows returns zero for same or previous tick", () => {
  assert.equal(computeMissedCronWindows(1000, 1000), 0);
  assert.equal(computeMissedCronWindows(2000, 1000), 0);
});

test("computeMissedCronWindows counts full skipped minutes", () => {
  const base = Date.parse("2026-02-25T17:00:00.000Z");
  assert.equal(computeMissedCronWindows(base, base + 59_000), 0);
  assert.equal(computeMissedCronWindows(base, base + 61_000), 0);
  assert.equal(computeMissedCronWindows(base, base + 180_000), 2);
});
