# Setup Spacebar Skill Selector

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
Operators wanted setup-time prebuilt skill selection to behave like OpenClaw multi-select UX (spacebar toggle), instead of one-by-one CLI enable flags.

## Scope
- Replace setup interactive prebuilt skill prompt with a keyboard multi-select list.
- Keep non-interactive list-style configuration via `--skills`.
- Remove old setup-only one-by-one skill flags to reduce command clutter.
- Update docs to reflect new setup UX.

## Non-goals
- Remove core `skills enable|disable` subcommands.
- Add external dependencies for prompt UI.

## Constraints
- Preserve existing setup env validation and output.
- Keep prebuilt scope explicit (`readwise`, `gmail`, `google-calendar`, `hey-email`).
- Preserve non-interactive automation path.

## Interfaces and contracts affected
- `bin/lib/butler-cli.mjs`
- `README.md`
- `docs/MCP.md`

## Acceptance criteria
- [x] Interactive setup renders a prebuilt skill list with spacebar toggle and enter to confirm.
- [x] Setup no longer requires one-by-one setup flags to select prebuilt skills.
- [x] Non-interactive setup supports list-style `--skills` selection.
- [x] Docs reflect the new setup controls.

## Verification commands
- [x] `npm run butler -- setup --help`
- [x] `npm run butler -- setup --yes --skip-doctor --env-path /tmp/butler-setup-spacebar-list.env --skills-config-path /tmp/butler-setup-spacebar-list.json --bot-token "<token>" --owner-ids "1" --gateway-token "0123456789abcdef" --worker-token "fedcba9876543210" --skills readwise,gmail --skill-env ACCESS_TOKEN=test-readwise-token`
- [x] Interactive PTY run with keypress flow:
  - start setup with TTY + required defaults
  - press enter through base prompts
  - use `space`, `down`, `space`, `enter` in prebuilt selector
  - provide `readwise:ACCESS_TOKEN`
  - confirm `.env` + skills config output
- [x] `npm run build`
- [x] `npm run harness:check`

## Execution checklist
- [x] Implement multi-select prompt renderer and key handlers.
- [x] Remove setup one-by-one prebuilt selection flags.
- [x] Update docs.
- [x] Run verification and record outcomes.

## Decision log
- 2026-02-20: Keep `--skills` as the non-interactive explicit list mode and remove setup-only one-by-one skill toggles for cleaner UX.

## Result
Implemented:
- Setup interactive mode now shows a keyboard multi-select skill list (arrow keys + spacebar + enter).
- Removed setup flags `--enable-prebuilt-skills`, `--enable-skill`, and `--disable-skill`.
- Kept explicit list mode `--skills` for automation and provisioning.
- Updated setup docs in `README.md` and `docs/MCP.md`.

Residual risks:
- Interactive keyboard UX relies on raw TTY behavior and may vary on unusual terminals.
