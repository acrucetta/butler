# Setup Onboarding Flow Alignment

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
Butler setup works, but it does not follow key onboarding ergonomics from OpenClaw (`keep/modify/reset` for existing config and quickstart-vs-advanced flow choice).

## Scope
- Add existing config decision prompt in interactive setup.
- Add `--flow quickstart|manual` option.
- Keep implementation lightweight and backward-compatible.

## Non-goals
- Full multi-step OpenClaw parity.
- New persisted wizard state.

## Constraints
- Preserve current non-interactive setup behavior.
- Avoid destructive reset operations.

## Interfaces and contracts affected
- `butler setup` CLI options and interactive prompts.
- `README.md` setup docs.

## Acceptance criteria
- [x] Interactive setup detects existing config and prompts `keep|modify|reset`.
- [x] Setup supports `--flow quickstart|manual`.
- [x] Quickstart uses fewer prompts than manual.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`
- [x] `npm run butler -- setup --help`

## Execution checklist
- [x] Update CLI options and setup logic.
- [x] Update README docs.
- [x] Run verification and record results.

## Decision log
- 2026-02-20: Use non-destructive reset semantics (ignore prior `.env` values and repopulate), avoiding file deletion.

## Result
Implemented lightweight onboarding alignment inspired by OpenClaw wizard behavior.

Behavior changes:
- `setup` now supports `--flow quickstart|manual`.
- Interactive setup now detects existing setup artifacts and prompts action:
  - `keep` (exit without changes)
  - `modify` (continue with current values)
  - `reset` (ignore prior env values and re-onboard)
- `quickstart` asks fewer prompts (bot token + owner IDs) and keeps generated/default infra values.

Verification outcomes:
- `npm run butler -- setup --help` passed and shows `--flow`.
- `npm run harness:check` passed.
- `npm run build` passed.

Residual risks:
- Existing-config action prompt is line-oriented (not full-screen TUI) to keep implementation simple.
