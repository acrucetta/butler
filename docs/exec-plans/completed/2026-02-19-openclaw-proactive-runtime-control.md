# OpenClaw Proactive Runtime Control Parity

- Owner: codex
- Status: completed
- Last updated: 2026-02-19

## Problem statement
Proactive heartbeat/cron automation exists, but rule management is static-file only and lacked OpenClaw-style scheduler options (`at/every`) plus delivery modes.

## Scope
- Add orchestrator APIs to list/create/delete heartbeat and cron rules at runtime.
- Persist runtime proactive config updates back to the proactive config file.
- Add OpenClaw-style control-plane tool endpoint for cron management (`/v1/tools/invoke`).
- Update docs for commands and API behavior.

## Non-goals
- Natural-language cron parsing beyond explicit command syntax.
- Webhook rule runtime editing in this change.
- Multi-channel command surfaces outside Telegram.

## Constraints
- Preserve gateway -> orchestrator -> worker boundaries.
- Maintain existing proactive job semantics (dedupe by trigger key, queue lifecycle, approval behavior).
- Keep gateway rule-management owner-only.
- Validate cron expressions and payload schemas at orchestrator boundary.

## Interfaces and contracts affected
- `packages/contracts/src/index.ts`
- `apps/orchestrator/src/proactive-runtime.ts`
- `apps/orchestrator/src/index.ts`
- `apps/telegram-gateway/src/orchestrator-client.ts`
- `README.md`
- `docs/product-specs/proactive-runtime.md`
- `docs/product-specs/telegram-control-plane.md`
- `docs/ARCHITECTURE.md`

## Acceptance criteria
- [x] Orchestrator exposes runtime API to create/list/delete cron rules.
- [x] Orchestrator exposes tool invocation API (`cron.list|add|update|remove|run`).
- [x] Orchestrator validates runtime rule changes and persists them to the proactive config file.
- [x] Existing proactive execution (enqueue + dedupe) remains unchanged.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Add proactive runtime rule management schemas/contracts.
- [x] Add orchestrator endpoints + config persistence wiring.
- [x] Add tool-invoke endpoint for cron parity.
- [x] Update docs and record result.

## Decision log
- 2026-02-19: Do not use Telegram scheduling commands; target OpenClaw-style tool-driven scheduler control.

## Result
Implemented control-plane cron parity for OpenClaw-style orchestration without Telegram scheduling commands:
- Added proactive config read/update endpoints and persisted updates to proactive config file.
- Added `/v1/tools` and `/v1/tools/invoke` with `cron.list|add|update|remove|run`, `heartbeat.list|add|update|remove|run`, and `proactive.runs`.
- Added `cron|at|everySeconds` schedule support with timezone-aware cron evaluation.
- Added manual immediate trigger path (`cron.run`) with dedupe preservation.
- Added session/wake semantics fields on cron rules (`sessionTarget`, `wakeMode`) and strict `next-heartbeat` handling for main-session wakes.
- Added recurring failure retry backoff (`30s -> 1m -> 5m -> 15m -> 60m`) with success reset.
- Added proactive delivery modes (`announce|webhook|none`) and gateway delivery loop with orchestrator pending/ack endpoints.
- Added proactive run ledger endpoint (`GET /v1/proactive/runs`) and tool (`proactive.runs`).
- Reverted Telegram command-based scheduling UX from gateway.
- Updated architecture/product docs and README.

Residual risks:
- Deterministic stagger for recurring schedules is not yet implemented.
