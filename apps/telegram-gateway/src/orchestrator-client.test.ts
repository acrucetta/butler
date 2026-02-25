import test from "node:test";
import assert from "node:assert/strict";

import { OrchestratorClient } from "./orchestrator-client.js";

const VALID_JOB = {
  id: "job-1",
  kind: "task",
  status: "queued",
  prompt: "hello",
  channel: "telegram",
  chatId: "chat-1",
  requesterId: "req-1",
  sessionKey: "sess-1",
  requiresApproval: false,
  abortRequested: false,
  createdAt: "2026-02-25T00:00:00.000Z",
  updatedAt: "2026-02-25T00:00:00.000Z"
} as const;

test("getJob retries once on transient network fetch failure", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify({ job: VALID_JOB }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const client = new OrchestratorClient("http://127.0.0.1:8787", "x".repeat(16), {
      requestTimeoutMs: 2_000,
      getRetryCount: 2,
      getRetryDelayMs: 0
    });
    const job = await client.getJob("job-1");
    assert.equal(job.id, "job-1");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getEvents retries once on retryable 503 response", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("temporary unavailable", { status: 503 });
    }
    return new Response(
      JSON.stringify({
        events: [],
        nextCursor: 0,
        total: 0
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const client = new OrchestratorClient("http://127.0.0.1:8787", "x".repeat(16), {
      requestTimeoutMs: 2_000,
      getRetryCount: 2,
      getRetryDelayMs: 0
    });
    const events = await client.getEvents("job-1", 0);
    assert.equal(events.total, 0);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createJob does not retry network failures for POST", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  try {
    const client = new OrchestratorClient("http://127.0.0.1:8787", "x".repeat(16), {
      requestTimeoutMs: 2_000,
      getRetryCount: 2,
      getRetryDelayMs: 0
    });
    await assert.rejects(() =>
      client.createJob({
        kind: "task",
        prompt: "test",
        channel: "telegram",
        chatId: "chat-1",
        requesterId: "req-1",
        sessionKey: "sess-1",
        requiresApproval: false
      })
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
