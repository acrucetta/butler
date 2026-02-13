# Architecture Doc Cleanup

- Owner: codex
- Status: completed
- Last updated: 2026-02-13

## Problem statement
`docs/ARCHITECTURE.md` mixed runtime flow, storage, and operator CLI details in one dense diagram, which made it hard to verify whether visual architecture reflected implemented code boundaries.

## Scope
- Refactor architecture diagrams for readability.
- Separate runtime topology and persistence surfaces.
- Add explicit implementation alignment references to source files.

## Non-goals
- No runtime behavior changes.
- No API contract changes.
- No security policy changes.

## Constraints
- Preserve actual gateway -> orchestrator -> worker boundaries.
- Keep endpoint lists and lifecycle states accurate to current code.
- Keep diagrams renderable in standard Mermaid markdown viewers.

## Interfaces and contracts affected
- `docs/ARCHITECTURE.md` only.

## Acceptance criteria
- [x] Architecture visuals are split into focused diagrams instead of one mixed graph.
- [x] Document includes concrete file references showing implementation alignment.
- [x] Existing lifecycle and interface sections remain accurate.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Review architecture doc and code paths in gateway/orchestrator/worker/contracts.
- [x] Rewrite architecture sections with cleaner diagrams.
- [x] Add implementation alignment section with source files.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-13: Split architecture into topology and persistence diagrams to reduce visual density without losing detail.
- 2026-02-13: Added explicit code references so future readers can verify architecture claims quickly.

## Result
The architecture document now reflects implemented boundaries more clearly and is easier to audit against source code. Residual risk: diagrams are still manually maintained and can drift if routes/components change without doc updates.
