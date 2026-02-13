# AGENTS.md

## Mission
Build and operate this repository as a reliable personal Pi + Telegram agent stack.
Humans define intent and constraints; agents execute with explicit specs and verifiable gates.

## Map
- `SPEC.md`: current top-level product goal.
- `docs/ARCHITECTURE.md`: runtime topology and interface contracts.
- `docs/PLANS.md`: how plans move from active to completed.
- `docs/exec-plans/PLAN_TEMPLATE.md`: required spec format for non-trivial work.
- `docs/QUALITY_SCORE.md`: quality baseline and debt tracking.
- `docs/RELIABILITY.md`: reliability targets and failure handling.
- `docs/SECURITY.md`: security invariants and trust boundaries.
- `docs/PRODUCT_SENSE.md`: product intent and UX priorities.
- `docs/design-docs/index.md`: design decisions and status.
- `docs/product-specs/index.md`: feature-level product specs.
- `docs/references/openai-agent-harness-best-practices.md`: external best-practice references.
- `.agents/skills/spec-driven-execution/SKILL.md`: reusable workflow for this repo.

## Default Loop
1. For non-trivial work, create or update an execution plan from `docs/exec-plans/PLAN_TEMPLATE.md`.
2. Implement in small, reversible diffs.
3. Run explicit verification commands.
4. Self-review for regressions, security, and maintainability.
5. Update docs, plans, and quality records in the same change.

## Guardrails
- Preserve gateway -> orchestrator -> worker boundaries.
- Validate external input and wire formats with schemas from `packages/contracts`.
- Keep authorization and approval controls intact for Telegram actions.
- Prefer deterministic logs/events over ad-hoc behavior.
- If behavior changes, update docs and operator commands in the same PR.

## Verification Commands
- `npm run harness:check`
- `npm run build`
- `npm run doctor` (requires configured environment variables)
- `npm run up` in mock mode for smoke checks when runtime behavior changes

## Done Criteria
A change is complete only when acceptance criteria are met, verification outcomes are recorded, and residual risks are documented.
