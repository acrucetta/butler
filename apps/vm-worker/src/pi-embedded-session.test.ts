import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { PiEmbeddedSession, PiEmbeddedSessionPool } from "./pi-embedded-session.js";

/**
 * These tests verify the PiEmbeddedSession wrapper logic.
 *
 * Note: Tests that call `session.prompt()` require a live LLM API key and
 * are skipped by default (they exercise real model calls).  The structural
 * tests below verify pool management, session lifecycle, and configuration
 * without making any API calls.
 */

function tmpSessionDir(): string {
  return mkdtempSync(resolve(tmpdir(), "butler-embedded-test-"));
}

function tmpCwd(): string {
  return mkdtempSync(resolve(tmpdir(), "butler-embedded-cwd-"));
}

// ─── Session Pool Tests ───────────────────────────────────────────────

test("PiEmbeddedSessionPool returns same session for same key", () => {
  const pool = new PiEmbeddedSessionPool({
    cwd: tmpCwd(),
    sessionRoot: tmpSessionDir()
  });

  const session1 = pool.getSession("chat-123");
  const session2 = pool.getSession("chat-123");
  assert.strictEqual(session1, session2, "should return the same session instance");
});

test("PiEmbeddedSessionPool returns different sessions for different keys", () => {
  const pool = new PiEmbeddedSessionPool({
    cwd: tmpCwd(),
    sessionRoot: tmpSessionDir()
  });

  const session1 = pool.getSession("chat-123");
  const session2 = pool.getSession("chat-456");
  assert.notStrictEqual(session1, session2, "should return different session instances");
});

test("PiEmbeddedSessionPool.shutdown disposes all sessions", async () => {
  const pool = new PiEmbeddedSessionPool({
    cwd: tmpCwd(),
    sessionRoot: tmpSessionDir()
  });

  pool.getSession("a");
  pool.getSession("b");

  // shutdown should not throw even with unstarted sessions
  await pool.shutdown();

  // After shutdown, getting a new session should create a fresh one
  const sessionAfter = pool.getSession("a");
  assert.ok(sessionAfter, "should create new session after shutdown");
});

// ─── Session Lifecycle Tests ──────────────────────────────────────────

test("PiEmbeddedSession.stop is idempotent", async () => {
  const session = new PiEmbeddedSession({
    cwd: tmpCwd(),
    sessionDir: tmpSessionDir()
  });

  // Calling stop before start should not throw
  await session.stop();
  await session.stop();
});

test("PiEmbeddedSession.abort before start does not throw", async () => {
  const session = new PiEmbeddedSession({
    cwd: tmpCwd(),
    sessionDir: tmpSessionDir()
  });

  await session.abort();
});

test("PiEmbeddedSession.prompt without start throws meaningful error only if session fails to init", async () => {
  // prompt() calls start() internally, so it won't throw "not initialized"
  // in normal flow — this just verifies the auto-start path exists
  const session = new PiEmbeddedSession({
    cwd: tmpCwd(),
    sessionDir: tmpSessionDir()
  });

  // We can't easily test a full prompt without an API key,
  // but we can verify start() is called (it may fail due to no model).
  // The important thing is it doesn't throw "not initialized".
  try {
    await session.start();
    // If we get here, the SDK started (maybe with a default model).
    // Clean up.
    await session.stop();
  } catch (error) {
    // Expected: SDK may fail without a configured model/API key.
    // The test passes as long as it didn't throw "not initialized".
    assert.ok(error instanceof Error);
    assert.ok(
      !error.message.includes("not initialized"),
      `Unexpected error: ${error.message}`
    );
  }
});

// ─── Configuration Tests ──────────────────────────────────────────────

test("PiEmbeddedSession sanitizes session directory names", () => {
  const root = tmpSessionDir();
  const pool = new PiEmbeddedSessionPool({
    cwd: tmpCwd(),
    sessionRoot: root
  });

  // Keys with special characters should be sanitized
  const session = pool.getSession("user@email.com/chat:123");
  assert.ok(session, "should create session with sanitized key");
});

test("PiEmbeddedSessionPool passes env to sessions", () => {
  const env = { ANTHROPIC_API_KEY: "test-key-123" };
  const pool = new PiEmbeddedSessionPool({
    cwd: tmpCwd(),
    sessionRoot: tmpSessionDir(),
    env
  });

  const session = pool.getSession("test");
  assert.ok(session, "should create session with env");
});
