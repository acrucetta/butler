import assert from "node:assert/strict";
import test from "node:test";
import type { ProactiveCronRule } from "@pi-self/contracts";
import { buildCronIdempotencyKey } from "./proactive-runtime.js";

function baseRule(partial: Partial<ProactiveCronRule>): ProactiveCronRule {
  return {
    id: "rule-1",
    prompt: "x",
    target: {
      kind: "task",
      chatId: "1",
      requesterId: "system:cron",
      sessionKey: "s",
      requiresApproval: false
    },
    ...partial
  } as ProactiveCronRule;
}

test("daily fixed-time cron uses date idempotency key", () => {
  const key = buildCronIdempotencyKey(
    baseRule({ id: "whoop", cron: "5 7 * * *", timezone: "America/Los_Angeles" }),
    new Date("2026-02-25T17:00:00.000Z")
  );
  assert.equal(key, "cron:whoop:date:2026-02-25");
});

test("multi-run cron uses minute key", () => {
  const key = buildCronIdempotencyKey(
    baseRule({ id: "frequent", cron: "*/15 * * * *" }),
    new Date("2026-02-25T17:34:00.000Z")
  );
  assert.equal(key, "cron:frequent:minute:2026-02-25T17:34");
});

test("at schedule uses fixed timestamp key", () => {
  const key = buildCronIdempotencyKey(
    baseRule({ id: "one-shot", at: "2026-02-25T17:34:00.000Z" }),
    new Date("2026-02-25T17:34:12.000Z")
  );
  assert.equal(key, "cron:one-shot:at:2026-02-25T17:34:00.000Z");
});
