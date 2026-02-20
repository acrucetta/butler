# Setup Wizard Prebuilt Skill Onboarding

- Owner: codex
- Status: completed
- Last updated: 2026-02-20
- Superseded by: `docs/exec-plans/completed/2026-02-20-setup-spacebar-skill-selector.md`

## Problem statement
`butler setup` configures Telegram/core env values but does not onboard prebuilt skills in the same first-run flow. Users must run separate skills commands after setup, which adds friction and inconsistent initial state.

## Scope
- Extend `butler setup` to support prebuilt skill selection during first-run.
- Support configuring required skill env vars during setup.
- Persist enabled skill choices into `.data/skills/config.json`.
- Keep existing `setup --yes` behavior compatible while allowing optional non-interactive skill enablement.
- Update docs for setup workflow and flags.

## Non-goals
- Implement OAuth browser flows inside Butler.
- Auto-install external CLIs (for example `gog`) in this change.
- Force MCP wrapper generation for all selected skills.

## Constraints
- Preserve existing Telegram setup validation and output.
- Preserve compatibility for existing automation using `setup --yes`.
- Keep skill handling constrained to prebuilt list: `readwise`, `gmail`, `google-calendar`, `hey-email`.

## Interfaces and contracts affected
- `bin/lib/butler-cli.mjs`
- `README.md`
- `docs/MCP.md`

## Acceptance criteria
- [x] Interactive `setup` prompts users to enable/disable prebuilt skills.
- [x] Interactive `setup` prompts for required env vars of selected skills.
- [x] Selected skills are written to skills config.
- [x] `setup --yes` remains non-interactive and does not break existing usage.
- [x] Optional non-interactive flags can enable prebuilt skills.

## Verification commands
- [x] `npm run butler -- setup --yes --skip-doctor --env-path /tmp/butler-setup-prebuilt.env --bot-token "<token>" --owner-ids "1" --gateway-token "0123456789abcdef" --worker-token "fedcba9876543210"`
- [x] `npm run butler -- setup --yes --skip-doctor --env-path /tmp/butler-setup-prebuilt-2.env --skills-config-path /tmp/butler-setup-prebuilt-skills.json --bot-token "<token>" --owner-ids "1" --gateway-token "0123456789abcdef" --worker-token "fedcba9876543210" --enable-prebuilt-skills --skill-env ACCESS_TOKEN=test-readwise-token`
- [x] `npm run build`
- [x] `npm run harness:check`
- [x] `npm run butler -- setup --help`

## Execution checklist
- [x] Add setup-skill selection/configuration logic.
- [x] Add non-interactive setup flags for prebuilt skills.
- [x] Update docs.
- [x] Run verification commands and record results.

## Decision log
- 2026-02-20: Keep prebuilt setup list explicit to avoid onboarding unfinished skills.

## Result
Implemented:
- `setup` now supports prebuilt skill onboarding with interactive enable/disable prompts for `readwise`, `gmail`, `google-calendar`, and `hey-email`.
- Added setup flags for non-interactive skill onboarding: `--enable-prebuilt-skills`, `--enable-skill`, `--skill-env`, and optional `--sync-selected-skills`.
- Setup writes selected skill env vars to the same env file and persists enabled skills in the configured skills config path.
- Added optional setup-time MCP sync execution for selected MCP-backed skills.
- Updated `README.md` and `docs/MCP.md` with setup-driven onboarding commands.

Residual risks:
- Interactive skill selection wasn’t automated in verification (TTY prompt path); non-interactive paths and help surface were verified.
- `--sync-selected-skills` depends on MCP config/runtime availability and can fail if local MCP manifests are missing.
