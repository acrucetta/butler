# OpenClaw-style Model Routing + Fallback (Worker)

- Owner: codex
- Status: completed
- Last updated: 2026-02-16

## Problem statement
Butler currently runs jobs on a single provider/model pair configured at worker boot. To better align with OpenClaw-style operation, worker execution should support profile-based routing, ordered fallback, and profile cooldown rotation.

## Scope
- Add worker model routing config loader.
- Add model profiles with provider/model/env overrides.
- Add per-job route selection by job kind and optional metadata override.
- Add ordered fallback attempts with retryability guardrails.
- Add cooldown-based profile rotation after retryable failures.
- Update docs and config examples.

## Non-goals
- Orchestrator-level model policy APIs.
- Full provider-specific error taxonomy.
- Dynamic model routing controlled from Telegram commands.

## Constraints
- Preserve gateway -> orchestrator -> worker boundaries and current job lifecycle.
- Keep legacy single-model behavior when routing config is absent.
- Avoid unsafe fallback after partial tool/output execution.
- Keep secrets out of committed defaults.

## Interfaces and contracts affected
- `apps/vm-worker/src/index.ts`
- `apps/vm-worker/src/model-routing.ts` (new)
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/product-specs/proactive-runtime.md` (no change expected)
- `docs/product-specs/model-routing.md` (new)
- `config/model-routing.example.json` (new)

## Acceptance criteria
- [x] Worker supports routing config file with multiple model profiles.
- [x] Jobs can route by kind (`task`/`run`) and optional metadata profile override.
- [x] Worker attempts fallback profile when failure is retryable and first attempt had no partial execution.
- [x] Retryable profile failures place that profile on cooldown; next jobs avoid cooled-down profiles when possible.
- [x] Legacy single-model mode still works with existing env vars.
- [x] Docs describe configuration and fallback behavior.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Implement model routing runtime module.
- [x] Integrate fallback execution loop into worker.
- [x] Add config example + product/architecture/docs updates.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-16: Keep model routing fully worker-local to avoid expanding orchestrator contracts in v1.

## Result
Completed.

Behavior:
- Added worker model routing runtime with profile definitions, route chains, retryable error patterns, and cooldown tracking.
- Added guarded fallback in worker execution loop: fallback only when error is retryable and no partial output/tool activity has occurred.
- Added legacy compatibility mode when routing config file is absent (`PI_PROVIDER` + `PI_MODEL` path remains intact).
- Added configuration example and docs/spec updates.

Verification outcomes:
- `npm run harness:check`: pass.
- `npm run build`: pass.

Residual risks / follow-up:
- Retryability classification is substring-based and may need provider-specific refinement.
- Profile cooldown state is in-memory and resets on worker restart.
