import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { getBuildArtifactIssue } from "./build-artifact-check.mjs";

function withTempDir(fn) {
  const root = mkdtempSync(resolve(tmpdir(), "butler-build-check-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("returns missing artifact issue", () => {
  withTempDir((root) => {
    const issue = getBuildArtifactIssue({
      serviceName: "orchestrator",
      artifactLabel: "apps/orchestrator/dist/index.js",
      sourceLabel: "apps/orchestrator/src/index.ts",
      artifactPath: resolve(root, "dist.js"),
      sourcePath: resolve(root, "src.ts")
    });
    assert.match(issue ?? "", /Missing build artifact/);
  });
});

test("returns stale artifact issue when source is newer", () => {
  withTempDir((root) => {
    const artifactPath = resolve(root, "dist.js");
    const sourcePath = resolve(root, "src.ts");
    writeFileSync(artifactPath, "artifact", "utf8");
    writeFileSync(sourcePath, "source", "utf8");

    const now = Date.now();
    utimesSync(artifactPath, new Date(now - 10_000), new Date(now - 10_000));
    utimesSync(sourcePath, new Date(now), new Date(now));

    const issue = getBuildArtifactIssue({
      serviceName: "orchestrator",
      artifactLabel: "apps/orchestrator/dist/index.js",
      sourceLabel: "apps/orchestrator/src/index.ts",
      artifactPath,
      sourcePath
    });
    assert.match(issue ?? "", /Stale build artifact/);
  });
});

test("returns null when artifact is current", () => {
  withTempDir((root) => {
    const artifactPath = resolve(root, "dist.js");
    const sourcePath = resolve(root, "src.ts");
    writeFileSync(artifactPath, "artifact", "utf8");
    writeFileSync(sourcePath, "source", "utf8");

    const now = Date.now();
    utimesSync(artifactPath, new Date(now), new Date(now));
    utimesSync(sourcePath, new Date(now - 10_000), new Date(now - 10_000));

    const issue = getBuildArtifactIssue({
      serviceName: "orchestrator",
      artifactLabel: "apps/orchestrator/dist/index.js",
      sourceLabel: "apps/orchestrator/src/index.ts",
      artifactPath,
      sourcePath
    });
    assert.equal(issue, null);
  });
});
