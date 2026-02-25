import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { acquireUpLock } from "./up-lock.mjs";

function withTempDir(fn) {
  const root = mkdtempSync(resolve(tmpdir(), "butler-up-lock-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("acquireUpLock creates lock file and release removes it", () => {
  withTempDir((root) => {
    const lockPath = resolve(root, "butler-up.lock");
    const lock = acquireUpLock(lockPath);
    const payload = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(payload.pid, process.pid);
    lock.release();
    assert.equal(lock.released, true);
    assert.equal(existsSync(lockPath), false);
  });
});

test("acquireUpLock rejects when active lock exists", () => {
  withTempDir((root) => {
    const lockPath = resolve(root, "butler-up.lock");
    const first = acquireUpLock(lockPath);
    assert.throws(() => acquireUpLock(lockPath), /already running/i);
    first.release();
  });
});

test("acquireUpLock removes stale lock and acquires", () => {
  withTempDir((root) => {
    const lockPath = resolve(root, "butler-up.lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() })}\n`, "utf8");
    const lock = acquireUpLock(lockPath);
    const payload = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(payload.pid, process.pid);
    lock.release();
  });
});

test("acquireUpLock treats EPERM probe as active lock", () => {
  withTempDir((root) => {
    const lockPath = resolve(root, "butler-up.lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 424242, createdAt: new Date().toISOString() })}\n`, "utf8");

    const originalKill = process.kill;
    // Simulate an environment where kill(pid, 0) is blocked but process may still be alive.
    process.kill = () => {
      const error = new Error("not permitted");
      error.code = "EPERM";
      throw error;
    };

    try {
      assert.throws(() => acquireUpLock(lockPath), /already running/i);
    } finally {
      process.kill = originalKill;
    }
  });
});
