# Setup Skill List Controls

- Owner: codex
- Status: completed
- Last updated: 2026-02-20
- Superseded by: `docs/exec-plans/completed/2026-02-20-setup-spacebar-skill-selector.md`

## Problem statement
`setup` currently supports `--enable-prebuilt-skills` and `--enable-skill`, but operators want explicit list-style control to enable/disable skills in one pass (similar to OpenClaw setup ergonomics).

## Scope
- Add list-style setup option for prebuilt skills.
- Add explicit disable option for setup.
- Keep existing flags backward compatible.
- Update docs and verify behavior.

## Non-goals
- Remove existing setup flags.
- Change runtime skill execution behavior.

## Constraints
- Preserve existing non-interactive setup compatibility.
- Keep validation strict for unknown skill ids.
- Keep prebuilt list controls scoped to prebuilt skills.

## Interfaces and contracts affected
- `bin/lib/butler-cli.mjs`
- `README.md`
- `docs/MCP.md`

## Acceptance criteria
- [x] Setup supports `--skills readwise,gmail` to set prebuilt selection explicitly.
- [x] Setup supports `--disable-skill <id>` for explicit disable.
- [x] Existing `--enable-prebuilt-skills` and `--enable-skill` continue to work.
- [x] Docs show list-style usage.

## Verification commands
- [x] `npm run butler -- setup --help`
- [x] `npm run butler -- setup --yes --skip-doctor --env-path /tmp/butler-setup-skills-list.env --skills-config-path /tmp/butler-setup-skills-list.json --bot-token "<token>" --owner-ids "1" --gateway-token "0123456789abcdef" --worker-token "fedcba9876543210" --skills readwise,gmail --skill-env ACCESS_TOKEN=test-readwise-token`
- [x] `npm run butler -- setup --yes --skip-doctor --env-path /tmp/butler-setup-skills-disable.env --skills-config-path /tmp/butler-setup-skills-disable.json --bot-token "<token>" --owner-ids "1" --gateway-token "0123456789abcdef" --worker-token "fedcba9876543210" --enable-prebuilt-skills --disable-skill gmail --skill-env ACCESS_TOKEN=test-readwise-token`
- [x] `npm run butler -- setup --yes --skip-doctor --env-path /tmp/butler-setup-skills-conflict.env --skills-config-path /tmp/butler-setup-skills-conflict.json --bot-token "<token>" --owner-ids "1" --gateway-token "0123456789abcdef" --worker-token "fedcba9876543210" --skills readwise,gmail --enable-prebuilt-skills` (expected failure)
- [x] `npm run build`
- [x] `npm run harness:check`

## Execution checklist
- [x] Add setup list/disable options and merge logic.
- [x] Update docs.
- [x] Run verification and capture outcomes.

## Decision log
- 2026-02-20: Keep list controls scoped to prebuilt skills for predictable first-run UX.

## Result
Implemented:
- Added setup flags: `--skills`, `--disable-skill` in addition to existing `--enable-prebuilt-skills` and `--enable-skill`.
- `--skills` now sets the explicit prebuilt skill selection in one pass (non-listed prebuilt skills are disabled).
- Added explicit conflict guard: `--skills` cannot be combined with `--enable-prebuilt-skills`.
- Updated setup docs in `README.md` and `docs/MCP.md`.

Residual risks:
- List mode currently scopes explicit-set semantics to prebuilt skills only; non-prebuilt skills continue to rely on enable/disable flags.
