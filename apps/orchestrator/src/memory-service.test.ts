import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryService } from "./memory-service.js";

function setupMemoryRoot(): { root: string; ledgerPath: string; service: MemoryService } {
  const root = mkdtempSync(resolve(tmpdir(), "butler-memory-test-"));
  const ledgerPath = resolve(root, ".data", "orchestrator", "memory-ledger.jsonl");
  mkdirSync(resolve(root, "memory"), { recursive: true });
  writeFileSync(resolve(root, "MEMORY.md"), "# MEMORY\n\n- durable baseline\n", "utf8");
  return { root, ledgerPath, service: new MemoryService(root, ledgerPath) };
}

test("memory.search ranks by relevance across daily and durable files", () => {
  const { root, service } = setupMemoryRoot();
  writeFileSync(
    resolve(root, "memory", "2026-02-18.md"),
    "# 2026-02-18\n\n- Alice project migration status unknown\n",
    "utf8"
  );
  writeFileSync(
    resolve(root, "memory", "2026-02-19.md"),
    "# 2026-02-19\n\n- pinged alice\n- project noted\n",
    "utf8"
  );
  writeFileSync(
    resolve(root, "MEMORY.md"),
    "# MEMORY\n\n- Alice project owner is Bob\n",
    "utf8"
  );

  const hits = service.search("alice project", 5);
  assert.ok(hits.length >= 2);
  assert.match(hits[0]?.text ?? "", /alice project/i);
  assert.ok(hits.some((hit) => hit.path.endsWith("MEMORY.md")));
});

test("memory.search uses recency as tie-breaker for equal scores", () => {
  const { root, service } = setupMemoryRoot();
  writeFileSync(resolve(root, "memory", "2026-02-18.md"), "# 2026-02-18\n\n- alpha token\n", "utf8");
  writeFileSync(resolve(root, "memory", "2026-02-19.md"), "# 2026-02-19\n\n- alpha token\n", "utf8");

  const hits = service.search("alpha token", 2);
  assert.equal(hits.length, 2);
  assert.ok(hits[0]?.path.endsWith("2026-02-19.md"));
  assert.ok(hits[1]?.path.endsWith("2026-02-18.md"));
});

test("memory.store writes durable and daily entries and appends ledger", () => {
  const { root, ledgerPath, service } = setupMemoryRoot();
  const durable = service.store("favorite editor is neovim", "durable");
  const daily = service.store("today discussed release tasks", "daily");

  const durableText = readFileSync(resolve(root, "MEMORY.md"), "utf8");
  assert.match(durableText, /favorite editor is neovim/i);
  assert.ok(durable.line > 0);

  const dailyText = readFileSync(daily.path, "utf8");
  assert.match(dailyText, /today discussed release tasks/i);

  const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
  assert.equal(ledgerLines.length, 2);
  const latest = JSON.parse(ledgerLines[1] ?? "{}") as { action?: string; scope?: string };
  assert.equal(latest.action, "store");
  assert.equal(latest.scope, "daily");
});

test("memory.ledger returns newest entries first and honors limit", () => {
  const { service } = setupMemoryRoot();
  service.store("entry one", "daily");
  service.store("entry two", "daily");
  service.store("entry three", "durable");

  const entries = service.ledger(2);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.text, "entry three");
  assert.equal(entries[1]?.text, "entry two");
});
