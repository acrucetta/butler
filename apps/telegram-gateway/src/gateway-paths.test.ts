import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { resolveGatewayDataPaths } from "./gateway-paths.js";

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(resolve(tmpdir(), "gateway-paths-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scaffoldWorkspace(root: string): void {
  mkdirSync(resolve(root, "apps", "telegram-gateway"), { recursive: true });
  mkdirSync(resolve(root, "apps", "orchestrator"), { recursive: true });
  mkdirSync(resolve(root, "packages", "contracts"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), '{"name":"test-workspace"}\n', "utf8");
}

test("defaults resolve to repo-root .data/gateway paths", () => {
  withTempDir((root) => {
    scaffoldWorkspace(root);
    const startDir = resolve(root, "apps", "telegram-gateway");

    const paths = resolveGatewayDataPaths({ startDir });

    assert.equal(paths.workspaceRoot, root);
    assert.equal(paths.pairingsFile, resolve(root, ".data", "gateway", "pairings.json"));
    assert.equal(paths.sessionsFile, resolve(root, ".data", "gateway", "sessions.json"));
  });
});

test("migrates legacy gateway data files when primary missing", () => {
  withTempDir((root) => {
    scaffoldWorkspace(root);
    const startDir = resolve(root, "apps", "telegram-gateway");
    const legacyPairings = resolve(root, "apps", "telegram-gateway", ".data", "gateway", "pairings.json");
    const legacySessions = resolve(root, "apps", "telegram-gateway", ".data", "gateway", "sessions.json");
    mkdirSync(resolve(root, "apps", "telegram-gateway", ".data", "gateway"), { recursive: true });
    writeFileSync(legacyPairings, '{"allowedUserIds":["1"],"pendingByUserId":{}}', "utf8");
    writeFileSync(legacySessions, '{"sessionsByRouteKey":{}}', "utf8");

    const logs: string[] = [];
    const paths = resolveGatewayDataPaths({
      startDir,
      logger: {
        log(message: string) {
          logs.push(message);
        }
      }
    });

    assert.equal(existsSync(paths.pairingsFile), true);
    assert.equal(existsSync(paths.sessionsFile), true);
    assert.equal(readFileSync(paths.pairingsFile, "utf8"), readFileSync(legacyPairings, "utf8"));
    assert.equal(readFileSync(paths.sessionsFile, "utf8"), readFileSync(legacySessions, "utf8"));
    assert.match(logs.join("\n"), /migrated legacy data file/);
  });
});

test("explicit env paths override default resolution", () => {
  withTempDir((root) => {
    scaffoldWorkspace(root);
    const startDir = resolve(root, "apps", "telegram-gateway");

    const paths = resolveGatewayDataPaths({
      startDir,
      pairingsFileEnv: "custom/pairings.json",
      sessionsFileEnv: "custom/sessions.json"
    });

    assert.equal(paths.pairingsFile, resolve(startDir, "custom", "pairings.json"));
    assert.equal(paths.sessionsFile, resolve(startDir, "custom", "sessions.json"));
  });
});
