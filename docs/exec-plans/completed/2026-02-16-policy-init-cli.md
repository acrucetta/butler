# Butler Policy Init Command

- Owner: codex
- Status: completed
- Last updated: 2026-02-16

## Problem statement
Users can customize worker tool policy, but setup currently requires manual file copy and path handling. We need a one-command scaffold with sensible defaults.

## Scope
- Add `butler policy init` command.
- Scaffold `.data/worker/tool-policy.json` from repo example defaults.
- Support `--force` overwrite behavior and path override.
- Document usage in README.

## Non-goals
- Runtime policy editing commands.
- Policy validation beyond JSON parse and shape basics.
- Orchestrator-side policy management.

## Constraints
- Keep CLI UX consistent with `mcp init` style.
- Preserve existing behavior for users not using the command.
- Keep implementation local to CLI and docs.

## Interfaces and contracts affected
- CLI command surface: `butler policy init`.
- README operator workflow.

## Acceptance criteria
- [x] `butler policy init` creates default policy file in `.data/worker/tool-policy.json`.
- [x] Command supports `--output-path` and `--force`.
- [x] Command fails clearly when target exists without `--force`.
- [x] README documents the command usage.

## Verification commands
- [x] `npm run test`
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Implement CLI command in `bin/lib/butler-cli.mjs`.
- [x] Update README policy section.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-16: Reuse `config/tool-policy.example.json` as source of truth to avoid duplicated policy defaults in CLI code.

## Result
Added `butler policy init` command that scaffolds a worker tool policy file from `config/tool-policy.example.json`, supports `--output-path` and `--force`, and validates source template JSON before writing. README now documents one-command policy bootstrap.

Verification:
- `npm run test` ✅
- `npm run harness:check` ✅
- `npm run build` ✅

Residual risks:
- Command currently validates only JSON object shape for template source; semantic policy validation remains enforced at worker startup.
