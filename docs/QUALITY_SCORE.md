# Quality Score

## Scoring Model
Each area is scored from `1` to `5`.
- `1`: missing or fragile
- `3`: acceptable baseline with known gaps
- `5`: consistently reliable and mechanically enforced

## Current Scorecard

| Area | Score | Notes | Next action |
| --- | --- | --- | --- |
| API contracts (`packages/contracts`) | 4 | Strong schema use via Zod | Add contract tests in CI |
| Orchestrator lifecycle logic | 3 | Clear job state transitions | Add persistence failure tests |
| Telegram authorization flow | 3 | Owner/pairing and command gating exist | Add regression tests for edge cases |
| Worker execution loop | 3 | Abort heartbeat and event streaming exist | Add retries/backoff policy tests |
| Documentation legibility for agents | 4 | Structured harness docs now in repo | Keep docs synced by check + review |
| Automated quality gates | 2 | Build and harness checks run locally | Wire `verify:harness` into CI |

## Update Rules
- Update this file whenever architecture, policy, or operational behavior changes.
- Keep "Next action" concrete and testable.
- Raise or lower scores only with evidence (tests, checks, incidents, or audits).
