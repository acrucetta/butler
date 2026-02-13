# Product Sense

## Core Users
- Owner operator: manages pairings, approvals, and panic controls.
- Paired user: requests tasks and checks status within access policy.

## High-value Flows
- Fast request to result for `/task` in normal operation.
- Controlled execution for `/run` through explicit approval.
- Clear visibility into job progress and final state.
- Safe global pause/resume through `/panic`.

## Non-goals
- Multi-tenant enterprise policy engine.
- Public internet hardening by default.
- Fully autonomous command execution without owner controls.

## UX Constraints
- Commands should fail with actionable messages.
- Authorization failures should be explicit and non-leaky.
- Job lifecycle states should be understandable from Telegram responses.
