import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadJsonWithLegacyFallback } from "./config-paths.js";

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(resolve(tmpdir(), "orch-config-paths-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("loads primary config when present", () => {
  withTempDir((root) => {
    const primary = resolve(root, "primary.json");
    const legacy = resolve(root, "legacy.json");
    writeFileSync(primary, '{"enabled":true}\n', "utf8");
    writeFileSync(legacy, '{"enabled":false}\n', "utf8");
    const value = loadJsonWithLegacyFallback(primary, legacy);
    assert.deepEqual(value, { enabled: true });
  });
});

test("migrates legacy config when primary missing", () => {
  withTempDir((root) => {
    const primaryDir = resolve(root, "new");
    mkdirSync(primaryDir, { recursive: true });
    const primary = resolve(primaryDir, "proactive-runtime.json");
    const legacy = resolve(root, "legacy-proactive-runtime.json");
    writeFileSync(legacy, '{"cronRules":[{"id":"x"}]}\n', "utf8");

    const messages: string[] = [];
    const value = loadJsonWithLegacyFallback(primary, legacy, {
      log(message: string) {
        messages.push(message);
      }
    });

    assert.equal(existsSync(primary), true);
    assert.deepEqual(value, { cronRules: [{ id: "x" }] });
    assert.match(messages[0] ?? "", /migrated legacy config/);
    assert.equal(readFileSync(primary, "utf8").trim(), '{"cronRules":[{"id":"x"}]}');
  });
});

test("returns empty object when neither file exists", () => {
  withTempDir((root) => {
    const value = loadJsonWithLegacyFallback(resolve(root, "missing.json"), resolve(root, "legacy-missing.json"));
    assert.deepEqual(value, {});
  });
});
