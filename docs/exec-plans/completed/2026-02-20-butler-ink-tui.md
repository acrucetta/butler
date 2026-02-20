# Butler Ink TUI MVP

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
Butler lacks a runtime terminal UI for operators who prefer an OpenClaw-style interactive control surface over command-only workflows.

## Scope
- Add a new `butler tui` command.
- Implement a minimal Ink-based runtime view with health/status information.
- Add basic keybindings for refresh, mode toggle, and exit.
- Document usage in `README.md`.

## Non-goals
- Full OpenClaw dashboard parity.
- Background process management from inside the TUI.
- New backend APIs or changes to orchestrator/worker/gateway contracts.

## Constraints
- Keep implementation intentionally simple and low-risk.
- Preserve existing CLI command behavior.
- Keep TUI optional and non-blocking for headless/automation usage.

## Interfaces and contracts affected
- `butler` CLI surface: add `tui` subcommand.
- Operator docs in `README.md`.
- Runtime dependency set (`ink` + `react`).

## Acceptance criteria
- [x] `npm run butler -- tui` launches a terminal UI in TTY environments.
- [x] TUI shows at least mode, doctor health summary, and skill/MCP state snapshot.
- [x] Keybindings exist for refresh, mode toggle, and quit.
- [x] Existing commands (`setup`, `up`, `doctor`, `skills`, `mcp`) keep working.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`
- [x] `npm run butler -- --help`
- [x] `npm run butler -- tui --help`

## Execution checklist
- [x] Add dependencies and TUI command wiring.
- [x] Implement minimal Ink screen and key handling.
- [x] Update README usage.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-20: Start with a simple status-oriented TUI and defer action-heavy controls to future iterations.

## Result
Implemented a simple Ink-based `butler tui` command focused on operator status snapshots and low-friction controls.

Behavior:
- New command: `npm run butler -- tui`.
- New options: `--mode` and `--refresh-ms`.
- Displays: doctor summary, enabled skills and missing env vars, MCP target/wrapper snapshot.
- Keybindings: `r` refresh, `m` toggle mode, `i` details, `q` quit.

Verification outcomes:
- `npm run harness:check` passed.
- `npm run build` passed.
- `npm run butler -- --help` includes `tui`.
- `npm run butler -- tui --help` shows expected options.

Residual risks:
- TUI launch behavior is validated for command wiring and help output, but full interactive UX was not captured in automated tests.
- This MVP intentionally avoids process orchestration controls inside the TUI to keep complexity low.
