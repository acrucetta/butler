import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { JobCreateRequest } from "@pi-self/contracts";
import { OrchestratorStore } from "./store.js";

function setupStore(): { root: string; store: OrchestratorStore } {
  const root = mkdtempSync(resolve(tmpdir(), "orchestrator-store-"));
  const store = new OrchestratorStore(resolve(root, "state.json"));
  return { root, store };
}

function createBaseRequest(metadata?: Record<string, string>): JobCreateRequest {
  return {
    kind: "task",
    prompt: "test",
    channel: "telegram",
    chatId: "1",
    requesterId: "u",
    sessionKey: "s",
    requiresApproval: false,
    metadata
  };
}

test("claimNextQueuedJob skips duplicate completed idempotency key", () => {
  const { root, store } = setupStore();
  try {
    const key = "cron:whoop:date:2026-02-25";
    const first = store.createJob(createBaseRequest({ proactiveIdempotencyKey: key }));
    const firstClaim = store.claimNextQueuedJob("worker-1");
    assert.equal(firstClaim?.id, first.id);
    store.completeJob(first.id, "first done");

    const second = store.createJob(createBaseRequest({ proactiveIdempotencyKey: key }));
    const secondClaim = store.claimNextQueuedJob("worker-1");
    assert.equal(secondClaim, undefined);

    const secondJob = store.getJob(second.id);
    assert.equal(secondJob?.status, "completed");
    assert.equal(secondJob?.resultText, "__SKIPPED_IDEMPOTENT__");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service status persists in store", () => {
  const { root, store } = setupStore();
  try {
    const status = {
      supervisor: { status: "running", pid: 1234 },
      services: { orchestrator: { status: "running" } }
    };
    store.setServiceStatus(status);
    assert.deepEqual(store.getServiceStatus(), status);

    const reloaded = new OrchestratorStore(resolve(root, "state.json"));
    assert.deepEqual(reloaded.getServiceStatus(), status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
