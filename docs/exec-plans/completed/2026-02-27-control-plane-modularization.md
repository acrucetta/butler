# Control-Plane Modularization (Gateway + Orchestrator)

- Owner: codex
- Status: completed
- Last updated: 2026-02-27

## Problem statement
Gateway and orchestrator entrypoints have high cognitive load due to mixed concerns (env parsing, dependency wiring, routing logic, and runtime loops in one file). This increases change amplification and obscures architecture boundaries.

## Scope
- Extract gateway runtime/env parsing into a dedicated config module.
- Extract orchestrator HTTP route registration into a dedicated module.
- Keep runtime behavior and API contracts unchanged.

## Non-goals
- Endpoint contract changes.
- Storage schema or queue semantics changes.
- Polling -> webhook transport migration.

## Constraints
- Preserve gateway -> orchestrator -> worker boundaries.
- Keep env variables and defaults backward compatible.
- Keep diff reversible and testable.

## Interfaces and contracts affected
- `apps/telegram-gateway/src/index.ts`
- `apps/telegram-gateway/src/gateway-config.ts` (new)
- `apps/orchestrator/src/index.ts`
- `apps/orchestrator/src/http-routes.ts` (new)

## Acceptance criteria
- [x] Gateway index no longer parses env directly; config module encapsulates parsing/validation.
- [x] Orchestrator index no longer contains route registration body; routes are registered via module.
- [x] Existing tests/build/harness checks pass.
- [x] Runtime starts successfully after refactor.

## Verification commands
- [x] `npm --workspace apps/telegram-gateway run test`
- [x] `npm run build`
- [x] `npm run harness:check`
- [x] `npm run butler -- up-status`

## Execution checklist
- [x] Add gateway config module and wire index to it.
- [x] Add orchestrator HTTP routes module and wire index to it.
- [x] Update docs if needed.
- [x] Run full verification and runtime smoke check.

## Decision log
- 2026-02-27: Prioritize deep modules for configuration and HTTP wiring to reduce top-level entrypoint complexity with minimal behavioral risk.

## Result
Implemented architecture-first modularization with no contract changes:

- Added `apps/telegram-gateway/src/gateway-config.ts` to own env parsing, validation, and gateway path resolution.
- Gateway `index.ts` now consumes a typed config object instead of parsing env inline.
- Added `apps/orchestrator/src/http-routes.ts` to own HTTP route registration, auth middleware wiring, and request/error handling.
- Orchestrator `index.ts` now focuses on lifecycle wiring (config, store/runtime initialization, start/stop hooks).

Verification:
- Gateway tests pass, including new `gateway-config` tests.
- Full build and harness checks pass.
- Runtime smoke verified with `npm run butler -- up-status`: supervisor/orchestrator/worker/gateway all running.

Residual risks:
- Telegram polling conflicts still depend on external token uniqueness and operator discipline; gateway now degrades gracefully but cannot kill remote pollers.
