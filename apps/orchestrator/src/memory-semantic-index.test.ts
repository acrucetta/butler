import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { MemorySemanticIndex } from "./memory-semantic-index.js";

function setup(): { root: string; indexFile: string; index: MemorySemanticIndex } {
  const root = mkdtempSync(resolve(tmpdir(), "butler-semantic-memory-"));
  mkdirSync(resolve(root, "memory"), { recursive: true });
  const indexFile = resolve(root, ".data", "orchestrator", "memory-index.json");
  const index = new MemorySemanticIndex({
    memoryRoot: root,
    indexFile
  });
  return { root, indexFile, index };
}

test("builds index and reports status", async () => {
  const { root, index } = setup();
  writeFileSync(resolve(root, "MEMORY.md"), "# MEMORY\n\n- calendar preferences and meeting windows\n", "utf8");
  writeFileSync(resolve(root, "memory", "2026-02-19.md"), "# 2026-02-19\n\n- reviewed readwise highlights\n", "utf8");

  const rebuilt = await index.rebuild();
  assert.ok(rebuilt.chunks > 0);

  const status = index.status();
  assert.equal(status.provider, "local");
  assert.ok(status.chunks > 0);
  assert.ok(typeof status.lastIndexedAt === "string");
});

test("semantic search ranks relevant chunks", async () => {
  const { root, index } = setup();
  writeFileSync(resolve(root, "MEMORY.md"), "# MEMORY\n\n- prefers morning calendar digest\n", "utf8");
  writeFileSync(resolve(root, "memory", "2026-02-18.md"), "# 2026-02-18\n\n- whoop recovery was low today\n", "utf8");
  writeFileSync(resolve(root, "memory", "2026-02-19.md"), "# 2026-02-19\n\n- readwise sync succeeded\n", "utf8");
  await index.rebuild();

  const hits = await index.search("calendar morning", 5);
  assert.ok(hits.length > 0);
  assert.match(hits[0]?.text ?? "", /calendar|morning/i);
});

test("detects stale sources and refreshes search results", async () => {
  const { root, index } = setup();
  writeFileSync(resolve(root, "MEMORY.md"), "# MEMORY\n\n- baseline\n", "utf8");
  await index.rebuild();

  writeFileSync(resolve(root, "MEMORY.md"), "# MEMORY\n\n- baseline\n- google maps commute route saved\n", "utf8");
  const hits = await index.search("commute route", 3);
  assert.ok(hits.some((hit) => /commute route/i.test(hit.text)));
});
