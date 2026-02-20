# Wire Readwise, Google, and HEY Skills

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
Butler has starter skill packages for Readwise, Gmail, and Google Calendar, but they are not wired to runnable MCP servers and cannot be used in deployed worker environments. HEY email support is also missing.

## Scope
- Wire `skills/readwise` to a concrete MCP server + target.
- Align `skills/gmail` and `skills/google-calendar` to OpenClaw's `gog` Google CLI workflow for deployment.
- Add a `skills/hey-email` package with deployment-ready bridge setup guidance.
- Update operator docs for local and droplet setup for these integrations.

## Non-goals
- Implement new upstream MCP servers.
- Build OAuth UI flows in Butler.
- Provide direct HEY API integration.

## Constraints
- Preserve base MCP behavior (`codex` remains the only default base target).
- Keep integration wiring opt-in through `skills enable` + `skills sync`.
- Keep secrets out of committed config; use env vars and runtime files.
- Keep docs explicit about auth prerequisites and HEY limitations.

## Interfaces and contracts affected
- `skills/readwise/skill.json`
- `skills/readwise/SKILL.md`
- `skills/gmail/skill.json`
- `skills/gmail/SKILL.md`
- `skills/google-calendar/skill.json`
- `skills/google-calendar/SKILL.md`
- `skills/hey-email/skill.json`
- `skills/hey-email/SKILL.md`
- `config/skills.example.json`
- `README.md`
- `docs/MCP.md`
- `docs/SECURITY.md`
- `docs/QUALITY_SCORE.md`

## Acceptance criteria
- [x] `readwise` skill manifest defines a concrete MCP server and target.
- [x] `gmail` and `google-calendar` are aligned to OpenClaw `gog` CLI setup with no conflicting MCP target assumptions.
- [x] `hey-email` skill package exists with clear HEY-to-Gmail bridge prerequisites.
- [x] Documentation includes droplet-ready setup steps for credentials, enablement, and wrapper sync behavior.
- [x] `skills sync --dry-run` shows the Readwise target without changing base MCP defaults.

## Verification commands
- [x] `npm run butler -- skills list`
- [x] `npm run butler -- skills sync --dry-run --target readwise --target gmail --target google-calendar --target hey-email`
- [x] `npm run build`
- [x] `npm run harness:check`

## Execution checklist
- [x] Create/update skill manifests and instructions.
- [x] Update setup docs for operator deployment.
- [x] Run verification commands and capture outcomes.
- [x] Move plan to completed with residual risks.

## Decision log
- 2026-02-20: Use OpenClaw's `gog` CLI for Google Calendar/Gmail flows per operator preference, instead of introducing a new Google MCP package.
- 2026-02-20: Implement HEY support through HEY-to-Gmail bridge workflow because HEY has no stable public API/MCP standard.

## Result
Implemented:
- `readwise` now has concrete MCP wiring (`@readwise/readwise-mcp`) and a `readwise` target.
- `gmail` and `google-calendar` now document and standardize on OpenClaw `gog` CLI auth/usage for droplet deployment.
- Added `hey-email` skill package with bridge-based HEY workflow through Gmail label queries.
- Updated operator docs across `README.md`, `docs/MCP.md`, `docs/SECURITY.md`, and `docs/QUALITY_SCORE.md`.

Residual risks:
- `gog auth login` requires browser-based OAuth; headless droplets need credential bootstrap (`~/.gog/` copy).
- HEY support depends on forwarding/bridge behavior and not a first-party HEY API.
