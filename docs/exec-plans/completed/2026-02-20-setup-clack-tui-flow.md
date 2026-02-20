# Setup Clack TUI Flow

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
Current Butler setup relies on ad-hoc readline prompts and custom key handlers, which does not match OpenClaw's wizard-grade TUI flow and produced unstable behavior in interactive runs.

## Scope
- Replace interactive setup prompts with `@clack/prompts` select/text/confirm/multiselect flow.
- Preserve non-interactive flags and behavior.
- Keep skill toggles and env key entry inside the same TUI flow.

## Non-goals
- Full OpenClaw feature parity across all onboarding domains.
- Reworking non-setup CLI commands.

## Constraints
- Keep implementation simple and low-risk.
- Do not break existing setup flags.

## Interfaces and contracts affected
- `butler setup` interactive prompt UX.
- Runtime dependencies (`@clack/prompts`).
- README setup documentation.

## Acceptance criteria
- [x] Interactive setup uses TUI Q&A prompts for flow selection, config handling, and skill selection.
- [x] Skill-specific env keys are prompted only for enabled skills.
- [x] Setup completes without the previous unsettled top-level await warning in normal interactive usage.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`
- [x] `npm run butler -- setup --help`
- [x] `npm run butler -- setup --env-path /tmp/butler-live.env --skills-config-path /tmp/butler-live-skills.json` (live TTY check)
- [x] `npm run butler -- setup --env-path /tmp/butler-live2.env --skills-config-path /tmp/butler-live2-skills.json` (live TTY check, zero selected skills)

## Execution checklist
- [x] Add clack dependency and helper wrapper.
- [x] Update setup + skills onboarding interactive paths.
- [x] Update docs and record verification outcomes.

## Decision log
- 2026-02-20: Mirror OpenClaw’s onboarding shape (flow select, config handling select, per-step prompts) but keep Butler-specific settings minimal.

## Result
Implemented OpenClaw-style step-by-step TUI onboarding for Butler setup.

Behavior:
- Interactive setup now uses `@clack/prompts` for select, multiselect, text, and confirm prompts.
- Flow selection (`quickstart`/`manual`) and existing config handling are now structured TUI steps.
- Skill selection is toggle-based, and required skill env keys are prompted only for selected skills.
- Sync confirmation is a TUI yes/no control.
- Skill selection supports empty selection (no forced prebuilt skill enablement).

Live check:
- Ran setup in a real PTY session and completed end-to-end flow.
- No `Detected unsettled top-level await` warning appeared during the live run.

Residual risks:
- This aligns the prompt UX pattern with OpenClaw but does not implement OpenClaw’s full onboarding domain coverage.
