# Plans

## Execution Plan Lifecycle
Execution plans are the control plane for non-trivial work in this repository.
Use plan files to make assumptions explicit, track decisions, and keep context in-repo.

- Active plans live in `docs/exec-plans/active/`.
- Completed plans live in `docs/exec-plans/completed/`.
- Use `docs/exec-plans/PLAN_TEMPLATE.md` for all new plans.

## Required Plan Sections
Every non-trivial plan must include:
- Problem statement
- Scope and non-goals
- Constraints
- Interfaces and contracts affected
- Acceptance criteria
- Verification commands
- Execution checklist
- Result and residual risks

## Plan States
- `active`: work in progress and still changing
- `completed`: merged or intentionally stopped with a clear outcome

## Operator Commands
- Validate harness structure: `npm run harness:check`
- Validate harness plus TypeScript builds: `npm run verify:harness`
