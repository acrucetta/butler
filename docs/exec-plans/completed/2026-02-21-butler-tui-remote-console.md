# Butler TUI Remote Console

- Owner: codex
- Status: completed
- Last updated: 2026-02-21

## Problem statement
Current `butler tui` only shows status snapshots. Operators cannot submit and monitor test jobs from the terminal, which slows remote validation on the droplet.

## Scope
- Extend `butler tui` with a command-console workflow that can:
  - compose and submit `task`/`run` prompts to orchestrator
  - poll and render job events/final state
  - approve or abort active jobs
- Add TUI CLI options/env defaults for test identity metadata.
- Update operator docs for usage and controls.

## Non-goals
- Full OpenClaw chat UX parity.
- Multi-job tabs/history persistence in TUI.
- New orchestrator API endpoints or schema changes.

## Constraints
- Preserve existing CLI behavior and backward compatibility.
- Keep gateway -> orchestrator -> worker contracts unchanged.
- Keep TUI usable over SSH and low-bandwidth terminal sessions.
- Do not require Telegram chat context for test jobs.

## Interfaces and contracts affected
- `butler tui` command options and interactive controls.
- Orchestrator HTTP usage from CLI (`/v1/jobs`, `/events`, `/approve`, `/abort`).
- Operator docs in `README.md` and architecture docs.

## Acceptance criteria
- [x] `npm run butler -- tui` still launches in TTY and keeps status snapshot features.
- [x] TUI can submit a remote test prompt as a job and display event/final status updates.
- [x] TUI can toggle `task`/`run`, approve pending runs, and abort active jobs.
- [x] Operator docs clearly describe controls and required env vars.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`
- [x] `npm run butler -- tui --help`

## Execution checklist
- [x] Add TUI remote console state/actions in `bin/lib/butler-cli.mjs`.
- [x] Add CLI options and env defaults for TUI identity metadata.
- [x] Update `README.md` usage docs.
- [x] Update `docs/ARCHITECTURE.md` interface notes.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-21: Reuse existing orchestrator HTTP contracts from gateway patterns instead of adding TUI-specific backend routes.
- 2026-02-21: Keep single-active-job polling in TUI (MVP) to reduce state complexity and avoid parallel run confusion.

## Result
Implemented OpenClaw-style remote operator flow in `butler tui`:
- Compose and submit prompts from TUI (`task`/`run`).
- Stream/poll job lifecycle + deltas + terminal state.
- Approve pending run jobs and abort active jobs.
- Optional initial message submit (`--message`).
- Configurable test identity (`chat-id/requester-id/session-key/thread-id`) with env defaults.

Verification outcomes:
- `npm run harness:check` passed.
- `npm run build` passed.
- `npm run butler -- tui --help` shows new options and usage.

Residual risks:
- Interactive keyboard behavior is not covered by automated tests.
- TUI currently tracks one active job at a time (intentional MVP scope).
