# Move Brave Search to Skills Architecture

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
Brave Search was still defined in base MCP manifests, which conflicted with the new simplified skills architecture where optional integrations should be managed via `skills/*`.

## Scope
- Remove `brave-search` from base MCP manifests and default MCP CLI scaffold.
- Add `skills/brave-search` package with env + MCP definitions.
- Update docs to reflect Brave Search as an optional skill.

## Non-goals
- Change other existing skill packages.
- Change orchestrator or gateway behavior.

## Constraints
- Preserve backward-compatible core MCP behavior for base `codex` target.
- Keep Brave Search available through skill enable + sync flow.

## Interfaces and contracts affected
- `config/mcporter.json`
- `config/mcp-clis.json`
- `bin/lib/butler-cli.mjs` (`mcp init` defaults)
- `skills/brave-search/*`
- `README.md`
- `docs/MCP.md`

## Acceptance criteria
- [x] `mcp list` shows only base `codex` target.
- [x] `skills list` includes `brave-search`.
- [x] Enabling `brave-search` and running `skills sync --dry-run --target brave-search` produces Brave Search mcporter commands.

## Verification commands
- [x] `npm run butler -- mcp list`
- [x] `npm run butler -- skills list`
- [x] `npm run butler -- skills enable brave-search`
- [x] `npm run butler -- skills sync --dry-run --target brave-search`
- [x] `node --test bin/lib/skills-lib.test.mjs`
- [x] `npm --workspace apps/vm-worker run test`
- [x] `npm run build`
- [x] `npm run harness:check`

## Execution checklist
- [x] Migrate Brave Search definitions from base manifests into skill package.
- [x] Update default MCP scaffold to base-only target.
- [x] Update docs.

## Decision log
- 2026-02-20: Keep base MCP minimal (`codex`) and make Brave Search opt-in via skills for architectural consistency.

## Result
Brave Search is now fully skill-driven. Base MCP targets remain minimal, while enabling the Brave Search skill reintroduces its MCP server/target through `skills sync`.
