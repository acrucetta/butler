# Agent Harness Bootstrap

- Owner: codex
- Status: completed
- Last updated: 2026-02-13

## Problem statement
The repository can run services, but it lacks a durable agent harness: a concise map (`AGENTS.md`), structured system-of-record docs, and mechanical checks to keep the harness from drifting.

## Scope
- Add root `AGENTS.md` as a map to authoritative docs.
- Add plan/process/reliability/security/product/quality docs.
- Add a reusable local skill for spec-driven execution.
- Add automated harness checks and npm scripts.

## Non-goals
- No app runtime behavior changes.
- No API contract changes.
- No CI pipeline integration in this change.

## Constraints
- Keep instructions concise and repo-local.
- Preserve existing app architecture and commands.
- Add checks that do not require secrets or external services.

## Interfaces and contracts affected
- `AGENTS.md` repository-level instruction contract.
- `package.json` scripts (`harness:check`, `verify:harness`).
- Documentation layout under `docs/`.

## Acceptance criteria
- [x] Harness docs exist and are discoverable from root map.
- [x] Harness drift is mechanically checked with a local command.
- [x] Verification command is available as a single npm script.
- [x] OpenAI best-practice references are captured in-repo with links.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Create root `AGENTS.md`.
- [x] Add docs structure and templates.
- [x] Add `.agents` skill for repeatable workflow.
- [x] Add harness checker and script wiring.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-13: Kept harness checks lightweight and file/heading based to avoid introducing external dependencies.
- 2026-02-13: Added a single reusable local skill to avoid overfitting the harness prematurely.

## Result
The repo now has a baseline agent harness with explicit operating docs and a mechanical checker. Residual risk: checks are structural, not semantic; CI integration can be added next so every PR enforces `npm run verify:harness`.
