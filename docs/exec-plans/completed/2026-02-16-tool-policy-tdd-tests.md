# Tool Policy Tests + TDD Loop

- Owner: codex
- Status: completed
- Last updated: 2026-02-16

## Problem statement
The new worker tool policy layer has no automated tests yet. We need test coverage to prevent regressions and a simple TDD loop command set for day-to-day development.

## Scope
- Add unit tests for `apps/vm-worker/src/tool-policy.ts`.
- Add a `test` script in `apps/vm-worker/package.json`.
- Add root-level test commands for gateway + worker.
- Document a lightweight TDD loop in README.

## Non-goals
- Full integration tests across orchestrator + worker RPC.
- Introducing a new test framework.
- Retrofitting test suites for all modules in one change.

## Constraints
- Keep existing runtime behavior unchanged.
- Reuse node test runner via `tsx --test`.
- Keep diffs narrow and maintainable.

## Interfaces and contracts affected
- NPM scripts (`package.json`, `apps/vm-worker/package.json`).
- Developer workflow docs (`README.md`).

## Acceptance criteria
- [x] Tool policy behavior is covered by automated tests for layering and precedence.
- [x] Worker workspace has a `test` command.
- [x] Root package exposes simple test commands usable for TDD.
- [x] Build and harness checks remain green.

## Verification commands
- [x] `npm --workspace apps/vm-worker run test`
- [x] `npm run test`
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Add `tool-policy.test.ts`.
- [x] Add npm scripts for worker/root test runs.
- [x] Document red/green/refactor loop in README.
- [x] Run verification and record results.

## Decision log
- 2026-02-16: Use node built-in `node:test` + `tsx --test` to keep setup minimal.

## Result
Added worker unit tests for tool policy layering, deny precedence, profile narrowing, missing-file behavior, and empty allowlist behavior. Added workspace and root test scripts to run gateway + worker tests consistently. Documented a minimal TDD loop in README.

Verification:
- `npm --workspace apps/vm-worker run test` ✅
- `npm run test` ✅
- `npm run harness:check` ✅
- `npm run build` ✅

Residual risks:
- Tool policy tests are unit-level and do not yet validate end-to-end worker/orchestrator job failure semantics under a live Pi RPC session.
