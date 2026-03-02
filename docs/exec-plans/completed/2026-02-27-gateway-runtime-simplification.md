# Gateway Runtime Simplification + Single-Runner Hardening

- Owner: codex
- Status: completed
- Last updated: 2026-02-27

## Problem statement
Telegram responsiveness is brittle when multiple pollers use the same bot token, and gateway runtime state paths are ambiguous (`apps/telegram-gateway/.data` vs repo-root `.data`), increasing cognitive load and operator error risk.

## Scope
- Harden gateway startup behavior for Telegram polling conflicts.
- Simplify gateway runtime path resolution for pairing/session state with explicit, documented defaults.
- Preserve backward compatibility with legacy gateway state location.
- Tighten single-runner startup guard behavior/documentation.

## Non-goals
- Re-architect transport from polling to webhooks.
- Introduce distributed leader election across hosts.
- Change orchestrator/worker API contracts.

## Constraints
- Preserve gateway -> orchestrator -> worker boundaries.
- Keep existing env overrides (`TG_PAIRINGS_FILE`, `TG_SESSIONS_FILE`) working.
- Avoid breaking existing pairing/session data.
- Keep diffs narrow and reversible.

## Interfaces and contracts affected
- `apps/telegram-gateway/src/index.ts`
- `apps/telegram-gateway/src/polling-retry.ts` (new)
- `apps/telegram-gateway/src/gateway-paths.ts` (new)
- `bin/lib/up-owner-guard.mjs`
- `README.md`
- `docs/RELIABILITY.md`

## Acceptance criteria
- [x] Gateway does not hard-crash on Telegram `getUpdates` conflict; it retries with bounded backoff.
- [x] Gateway default state paths resolve deterministically to repo-root `.data/gateway/*` with legacy fallback behavior.
- [x] Existing env path overrides continue to work.
- [x] Build and relevant tests pass.
- [x] Reliability docs explain prevention and recovery.

## Verification commands
- [x] `npm --workspace apps/telegram-gateway run test`
- [x] `node --test bin/lib/up-owner-guard.test.mjs`
- [x] `npm run build`
- [x] `npm run harness:check`

## Execution checklist
- [x] Add polling conflict classification + retry backoff helper and tests.
- [x] Wire gateway startup to resilient polling retry loop.
- [x] Improve owner guard fallback behavior and tests.
- [x] Add gateway path resolver module with legacy fallback and tests.
- [x] Wire resolver into gateway bootstrap and remove path ambiguity.
- [x] Update docs and record results.

## Decision log
- 2026-02-27: Handle Telegram 409 conflicts in gateway loop rather than process-level crash/restart to reduce incident blast radius.
- 2026-02-27: Favor single-runner guard + deterministic path resolution over broad runtime redesign for immediate reliability gains.

## Result
Implemented a reliability-focused simplification pass that reduced operator-facing ambiguity and crash sensitivity in the control plane:

- Gateway startup now handles Telegram polling conflicts (`getUpdates` 409) with bounded retry/backoff instead of process crash loops.
- Gateway default pairing/session paths are deterministic at repo-root `.data/gateway/*`.
- Legacy gateway files (`apps/telegram-gateway/.data/gateway/*`) are migrated forward once when primary files are missing.
- Single-runner guard now falls back to hostname when `BUTLER_UP_OWNER` is unset, making `BUTLER_UP_OWNER_REQUIRED` operationally easier.
- README and reliability docs now document these behaviors.

Residual risks:
- Telegram 409 still indicates an external duplicate bot poller; this patch reduces crash impact but cannot identify/stop remote pollers.
- Full prevention still requires operational single-runner discipline (or token rotation when origin is unknown).
