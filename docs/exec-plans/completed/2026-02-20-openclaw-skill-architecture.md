# OpenClaw-Inspired Skills for Butler (Simplified Personal Model)

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
Butler lacked a first-class skill packaging and enablement layer, so adding integrations (Google Calendar, Gmail, Maps, Readwise, Whoop, Apple Health) required manual prompt and MCP wiring.

## Scope
- Add a local skill package contract (`skills/<id>/skill.json` + `skills/<id>/SKILL.md`).
- Add Butler CLI commands to initialize/list/add/setup/enable/disable/sync skills.
- Merge enabled skill MCP servers/targets into generated MCP wrapper sync inputs.
- Inject selected enabled skills into worker prompt context with `auto|always|off` modes.
- Add tests for runtime skill discovery/config/selection.
- Add starter skill packages for target integrations.
- Update docs (`README`, `ARCHITECTURE`, `MCP`) for operator usage.

## Non-goals
- Build remote marketplace auth flows (ClawHub equivalent).
- Implement each third-party integration server in this change.
- Add orchestrator-managed policy for skill permission review.

## Constraints
- Backward compatible when no skill config exists.
- Preserve gateway -> orchestrator -> worker layering.
- Keep runtime local-first and file-based.
- Do not break existing `butler mcp` flows.

## Interfaces and contracts affected
- CLI: `butler skills init|list|add|setup|enable|disable|sync`
- Worker env/config:
  - `PI_SKILLS_CONFIG_FILE`
  - `PI_SKILLS_DIR`
  - `PI_SKILLS_MODE` (`auto|always|off`)
  - `PI_SKILLS_CONTEXT_WINDOW`
  - `PI_SKILLS_MAX_CHARS`
- Skill files: `skills/<id>/skill.json`, `skills/<id>/SKILL.md`
- Generated artifacts: `.data/skills/*`

## Acceptance criteria
- [x] Butler discovers skills from local `skills/` directory.
- [x] Enabled skills can be listed and toggled from CLI.
- [x] `butler skills sync` generates merged MCP inputs and can run wrapper generation.
- [x] Worker prompt includes selected skills in `auto|always` mode and excludes in `off` mode.
- [x] Existing runtime behavior remains unchanged if no skill config is used.

## Verification commands
- [x] `npm --workspace apps/vm-worker run test`
- [x] `npm run build`
- [x] `npm run harness:check`
- [x] `npm run butler -- skills list`
- [x] `npm run butler -- skills sync --dry-run`

## Execution checklist
- [x] Implement skill runtime modules + tests.
- [x] Implement CLI `skills` commands and MCP merge flow.
- [x] Add starter skill packages.
- [x] Update docs and mark plan completed.

## Decision log
- 2026-02-20: Started with layered discovery (`workspace/user/builtin`) to mirror OpenClaw internals.
- 2026-02-20: Switched to single-user simplified model per operator preference: one `skills/` source + explicit enable list.

## Result
Implemented a simplified personal skill architecture that keeps OpenClaw-style packaging and runtime injection while removing multi-layer complexity. Skills are now easy to add, configure, enable, and sync via Butler CLI, with worker-side skill context selection and backward-compatible defaults.

Residual risks:
- Third-party MCP skill servers are still operator-provided; package availability/auth issues surface at runtime.
- No dedicated CLI unit tests yet for `skills setup` parsing and env writes.
