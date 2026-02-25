import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { JobCreateRequest } from "@pi-self/contracts";
import { OrchestratorStore } from "./store.js";

function setupStore(): { root: string; file: string; store: OrchestratorStore } {
  const root = mkdtempSync(resolve(tmpdir(), "orchestrator-store-stale-"));
  const file = resolve(root, "state.json");
  const store = new OrchestratorStore(file);
  return { root, file, store };
}

function createBaseRequest(): JobCreateRequest {
  return {
    kind: "task",
    prompt: "test",
    channel: "telegram",
    chatId: "1",
    requesterId: "u",
    sessionKey: "s",
    requiresApproval: false
  };
}

function setJobUpdatedAt(filePath: string, jobId: string, updatedAt: string): void {
  const state = JSON.parse(readFileSync(filePath, "utf8")) as {
    jobs: Record<string, { updatedAt?: string }>;
  };
  state.jobs[jobId].updatedAt = updatedAt;
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

test("stale running job is auto-failed by reaper", () => {
  const { root, file, store } = setupStore();
  try {
    const job = store.createJob(createBaseRequest());
    const claimed = store.claimNextQueuedJob("worker-1");
    assert.equal(claimed?.id, job.id);
    setJobUpdatedAt(file, job.id, "2026-02-25T00:00:00.000Z");

    const reloaded = new OrchestratorStore(file);
    const reaped = reloaded.reapStaleActiveJobs(60_000, Date.parse("2026-02-25T00:10:00.000Z"));
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]?.id, job.id);
    assert.equal(reaped[0]?.status, "failed");
    assert.match(reaped[0]?.error ?? "", /stale_running_timeout/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale aborting job is auto-aborted by reaper", () => {
  const { root, file, store } = setupStore();
  try {
    const job = store.createJob(createBaseRequest());
    const claimed = store.claimNextQueuedJob("worker-1");
    assert.equal(claimed?.id, job.id);
    const aborting = store.requestAbort(job.id);
    assert.equal(aborting?.status, "aborting");
    setJobUpdatedAt(file, job.id, "2026-02-25T00:00:00.000Z");

    const reloaded = new OrchestratorStore(file);
    const reaped = reloaded.reapStaleActiveJobs(60_000, Date.parse("2026-02-25T00:10:00.000Z"));
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]?.id, job.id);
    assert.equal(reaped[0]?.status, "aborted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat touch refreshes updatedAt for running jobs", () => {
  const { root, file, store } = setupStore();
  try {
    const job = store.createJob(createBaseRequest());
    const claimed = store.claimNextQueuedJob("worker-1");
    assert.equal(claimed?.id, job.id);
    setJobUpdatedAt(file, job.id, "2026-02-25T00:00:00.000Z");

    const reloaded = new OrchestratorStore(file);
    const touched = reloaded.touchJobHeartbeat(job.id);
    assert.equal(touched, true);
    const refreshed = reloaded.getJob(job.id);
    assert.notEqual(refreshed?.updatedAt, "2026-02-25T00:00:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
