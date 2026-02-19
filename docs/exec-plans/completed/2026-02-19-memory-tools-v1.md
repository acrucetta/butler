# Memory Tools v1 (Search + Store + Ledger)

- Owner: codex
- Status: completed
- Last updated: 2026-02-19

## Problem statement
Memory is file-based in Butler but lacked an orchestrator tool surface for structured memory search/store and write auditability.

## Scope
- Add orchestrator memory service for file-backed memory search and writes.
- Expose tool calls via `/v1/tools/invoke`: `memory.search`, `memory.store`, `memory.ledger`.
- Add persistent write ledger in JSONL.
- Document usage and env overrides.

## Non-goals
- Semantic embeddings/vector index.
- Automatic memory extraction/compaction.
- Multi-scope policy engine beyond daily/durable.

## Constraints
- Keep memory source of truth in markdown files (`MEMORY.md`, `memory/YYYY-MM-DD.md`).
- Keep implementation local-file based and deterministic.
- Preserve existing gateway/orchestrator/worker boundaries.

## Interfaces and contracts affected
- `apps/orchestrator/src/memory-service.ts`
- `apps/orchestrator/src/index.ts`
- `README.md`

## Acceptance criteria
- [x] `memory.search` returns relevance-ranked hits across daily and durable memory files.
- [x] `memory.store` appends entries to daily/durable memory files.
- [x] Memory writes are logged in a persistent ledger.
- [x] Tool endpoints documented in README.

## Verification commands
- [x] `npm run build`
- [x] `npm run harness:check`

## Execution checklist
- [x] Implement file-backed memory service.
- [x] Add tools and handlers in orchestrator.
- [x] Update documentation.

## Decision log
- 2026-02-19: Use relevance-ranked search across daily and durable files to better mimic OpenClaw-style memory recall behavior.

## Result
Added a practical memory tool surface aligned with existing file-based memory architecture. The orchestrator now supports memory search/store operations and maintains a write ledger for observability.

Residual risks:
- Search is lexical (substring) and not semantic.
- No dedupe/conflict resolution on writes yet.
