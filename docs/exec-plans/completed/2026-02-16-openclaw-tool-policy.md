# OpenClaw-Style Tool Policy Layer (Worker-Local)

- Owner: codex
- Status: completed
- Last updated: 2026-02-16

## Problem statement
Butler currently allows any runtime tool surfaced by Pi during RPC sessions. Operators need a simple, explicit policy layer to allow/deny tool usage by job kind, with optional profile-level overrides, to reduce blast radius while preserving the existing UX.

## Scope
- Add worker-local tool policy config loader and evaluator.
- Enforce policy during RPC execution when tool events are emitted.
- Fail a job when a disallowed tool is invoked.
- Add env/config docs and an example config.
- Update architecture/security/reliability/product spec docs.

## Non-goals
- Orchestrator-side policy management.
- Telegram command UX for policy edits.
- Provider/model-specific tool policy controls beyond profile id override.
- Sandboxing changes or host-level command approval UIs.

## Constraints
- Preserve gateway -> orchestrator -> worker boundaries.
- Keep default behavior backward compatible when no policy file is configured.
- Keep policy evaluation deterministic and easy to audit in events/logs.
- Avoid introducing new external dependencies.

## Interfaces and contracts affected
- Worker runtime env/config:
  - `PI_TOOL_POLICY_FILE` (optional)
- Worker runtime behavior:
  - job fails when policy denies tool invocation.
- Documentation:
  - README + architecture/security/reliability + product specs.

## Acceptance criteria
- [x] Worker can load tool policy rules from JSON file.
- [x] Policy supports layered `default` + `byKind` + `byProfile` allow/deny logic.
- [x] Disallowed tool invocation emits clear worker log event and fails the job.
- [x] If no policy file exists, behavior remains allow-all (backward compatible).
- [x] Docs describe config format and operational behavior.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Implement `tool-policy` runtime in worker.
- [x] Integrate policy enforcement into RPC callback flow.
- [x] Add example config + README usage notes.
- [x] Update architecture/security/reliability/product specs.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-16: Keep policy worker-local to avoid changing orchestrator contracts in v1.

## Result
Implemented a worker-local tool policy runtime (`default` -> `byKind` -> `byProfile`) with wildcard pattern support. The worker now evaluates tool invocations in RPC mode, logs denied tool attempts, aborts the active attempt, and fails the job without changing gateway/orchestrator APIs.

Verification:
- `npm run harness:check` ✅
- `npm run build` ✅

Residual risks:
- Enforcement occurs on runtime tool start events; effectiveness depends on timely event emission from Pi RPC.
- No Telegram/admin UX exists yet for runtime policy inspection or edits.
