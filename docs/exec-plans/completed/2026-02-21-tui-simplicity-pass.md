# Butler TUI Simplicity Pass

- Owner: codex
- Status: completed
- Last updated: 2026-02-21

## Problem statement
The operator TUI became visually noisy and over-featured for remote testing. Operators wanted a simple text bar interaction model with fewer confusing controls and clearer docs.

## Scope
- Replace fullscreen Ink UI with a line-based command bar.
- Remove TUI-only complexity (`mode`/`refresh` controls, keybinding matrix, status dashboard rendering).
- Simplify execution-mode defaults for `doctor`/`up`.
- Remove unused TUI runtime dependencies and update docs.

## Non-goals
- Remove all advanced Butler CLI commands.
- Change orchestrator API contracts.
- Rework Telegram UX.

## Constraints
- Preserve remote job submit/approve/abort behavior.
- Keep existing orchestration contracts (`/v1/jobs`, `/events`, `/approve`, `/abort`).
- Keep `up`, `doctor`, `skills`, and `mcp` commands operational.

## Interfaces and contracts affected
- `butler tui` command flags and runtime behavior.
- `butler up`/`butler doctor` default mode selection behavior.
- README operator instructions.

## Acceptance criteria
- [x] `butler tui` uses a minimal text-bar UX.
- [x] TUI supports prompt submit + status + approve + abort through slash commands.
- [x] TUI no longer requires `ink`/`react`.
- [x] README reflects the simplified TUI and execution-mode guidance.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`
- [x] `npm run butler -- tui --help`

## Execution checklist
- [x] Replace Ink UI implementation with readline command bar.
- [x] Trim `tui` CLI options to essential fields.
- [x] Remove unused TUI helper code and dependencies.
- [x] Update README + quality notes.
- [x] Run verification commands.

## Decision log
- 2026-02-21: Keep `mock|rpc` override flags for `up`/`doctor`, but auto-select default mode based on whether `pi` is installed.
- 2026-02-21: Use slash commands in TUI instead of keybinding-rich fullscreen controls.

## Result
`butler tui` is now a minimal command bar:
- Submit any plain-text line as a prompt.
- Use `/help`, `/kind`, `/status`, `/approve`, `/abort`, `/quit`.
- Active job polling and final output still flow through orchestrator APIs.

Residual risks:
- Polling output can still interleave with typing under heavy updates (line-based TTY limitation).
- No automated interactive TUI test coverage yet.
