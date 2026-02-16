# Proactive Runtime v1 (Heartbeats/Cron/Webhooks)

- Owner: codex
- Status: completed
- Last updated: 2026-02-16

## Problem statement
Butler currently runs only user-triggered jobs. We need orchestrator-native proactive triggers so the system can enqueue work from heartbeat intervals, cron schedules, and inbound webhooks.

## Scope
- Add orchestrator proactive runtime module with config-driven triggers.
- Support heartbeat interval triggers.
- Support cron expression triggers.
- Support webhook-triggered jobs with per-webhook secret validation.
- Expose proactive runtime health/state via orchestrator API.
- Document configuration and behavior in repo docs.

## Non-goals
- Gateway command UX for managing proactive rules.
- Persistent DB-backed scheduler state.
- Rich cron syntax beyond standard 5-field minute granularity.
- External webhook signature providers (GitHub/Stripe specific verification).

## Constraints
- Preserve gateway -> orchestrator -> worker boundaries and existing job lifecycle.
- Reuse existing job queue/state machine; proactive jobs must be ordinary jobs after enqueue.
- Keep secrets out of repo defaults; webhook auth uses runtime config.
- Avoid duplicate proactive enqueues when previous trigger run is still active.

## Interfaces and contracts affected
- `apps/orchestrator/src/index.ts`
- `apps/orchestrator/src/store.ts`
- `apps/orchestrator/src/proactive-runtime.ts` (new)
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/product-specs/index.md`
- `docs/product-specs/proactive-runtime.md` (new)

## Acceptance criteria
- [x] Orchestrator can load proactive trigger config from file and start runtime loop.
- [x] Heartbeat rules enqueue jobs at configured intervals.
- [x] Cron rules enqueue jobs when expression matches current minute.
- [x] Webhook rules enqueue jobs only when webhook ID exists and secret matches.
- [x] Duplicate proactive jobs for the same trigger are skipped while one is non-terminal.
- [x] Docs describe configuration format, auth behavior, and operational limits.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Implement proactive runtime types + parser + scheduler loop.
- [x] Wire runtime into orchestrator startup and add webhook/state endpoints.
- [x] Add store helper to detect active proactive jobs.
- [x] Add/refresh docs and product spec entries.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-16: Implement proactive runtime inside orchestrator to keep triggering deterministic and aligned with current control-plane ownership.

## Result
Completed.

Behavior:
- Added orchestrator proactive runtime with config-driven heartbeat, cron, and webhook triggers.
- Added dedupe guard to skip proactive enqueues while a previous job for the same trigger remains non-terminal.
- Added webhook ingress endpoint with per-webhook secret validation.
- Added proactive runtime state endpoint for operators.
- Added docs + product spec + config example for runtime setup.

Verification outcomes:
- `npm run harness:check`: pass.
- `npm run build`: pass.

Residual risks / follow-up:
- Cron support is intentionally minimal (5-field minute syntax with numeric ranges/lists/steps only; no named months/weekdays).
- Scheduler offsets are in-memory and reset on orchestrator restart.
