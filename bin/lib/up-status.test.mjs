import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createUpStatusStore, readUpStatus } from "./up-status.mjs";

function withTempDir(fn) {
  const root = mkdtempSync(resolve(tmpdir(), "butler-up-status-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("createUpStatusStore writes initial status", () => {
  withTempDir((root) => {
    const filePath = resolve(root, "up-status.json");
    const store = createUpStatusStore(filePath, {
      runtime: "start",
      workerMode: "embedded",
      services: ["orchestrator", "worker"]
    });
    assert.equal(existsSync(filePath), true);
    const status = store.snapshot();
    assert.equal(status.supervisor.runtime, "start");
    assert.equal(status.services.orchestrator.status, "idle");
  });
});

test("service transitions persist to disk", () => {
  withTempDir((root) => {
    const filePath = resolve(root, "up-status.json");
    const store = createUpStatusStore(filePath, {
      runtime: "start",
      workerMode: "embedded",
      services: ["orchestrator"]
    });
    store.markServiceStarting("orchestrator");
    store.markServiceRunning("orchestrator", 12345);
    store.markServiceExited("orchestrator", 1, null);
    store.markServiceRestartScheduled("orchestrator", 2, 1000);
    store.setSupervisorStatus("stopping");

    const status = readUpStatus(filePath);
    assert.equal(status.supervisor.status, "stopping");
    assert.equal(status.services.orchestrator.restartCount, 2);
    assert.equal(status.services.orchestrator.status, "restart_scheduled");
    assert.equal(status.services.orchestrator.lastExit.code, 1);
  });
});
