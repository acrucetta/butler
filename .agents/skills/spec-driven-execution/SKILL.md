---
name: "spec-driven-execution"
description: "Use for non-trivial implementation tasks in this repo to enforce spec-first execution, explicit verification, and documentation updates."
---

# Spec-Driven Execution

Use this skill for medium or large changes in this repository.

## Workflow
1. Create or update an execution plan from `docs/exec-plans/PLAN_TEMPLATE.md`.
2. Confirm scope, non-goals, constraints, and acceptance criteria before coding.
3. Implement in narrow diffs that preserve the gateway -> orchestrator -> worker layering.
4. Run verification commands from the plan.
5. Update affected docs (`ARCHITECTURE`, `QUALITY_SCORE`, `SECURITY`, `RELIABILITY`, product specs) when behavior changes.
6. Record verification outcomes and residual risks in the plan result.

## Required checks
- `npm run harness:check`
- `npm run build`

## Completion standard
A task is not complete until acceptance criteria are checked off and verification results are recorded in the plan.
