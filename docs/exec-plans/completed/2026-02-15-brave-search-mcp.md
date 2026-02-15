# Add Brave Search via MCP

- Owner: codex
- Status: completed
- Last updated: 2026-02-15

## Problem statement
Butler currently ships MCP wiring with a `codex` target but no web search target. Users need Brave Search available to PI sessions in the same MCP/mcporter workflow.

## Scope
- Add Brave Search MCP server definition.
- Add Brave Search target to MCP CLI generation config.
- Update CLI defaults so fresh `butler mcp init` includes Brave Search.
- Document operator setup for `BRAVE_API_KEY`.

## Non-goals
- Implementing a native Butler web search API/tool.
- Replacing or changing Pi provider/model routing.
- Shipping Brave credentials in repo files.

## Constraints
- Preserve existing gateway -> orchestrator -> worker boundaries.
- Keep MCP changes backward-compatible with existing `codex` target.
- Require explicit runtime credential (`BRAVE_API_KEY`) and avoid hardcoded secrets.

## Interfaces and contracts affected
- `config/mcporter.json`
- `config/mcp-clis.json`
- `bin/lib/butler-cli.mjs`
- `docs/MCP.md`
- `README.md`

## Acceptance criteria
- [x] `config/mcporter.json` contains a Brave MCP server entry.
- [x] `config/mcp-clis.json` includes a `brave-search` target.
- [x] `butler mcp init` default manifest includes `brave-search`.
- [x] Docs describe required `BRAVE_API_KEY` and sync flow.

## Verification commands
- [x] `npm run butler -- mcp list`
- [x] `npm run butler -- mcp sync --dry-run`
- [x] `npm run harness:check`
- [x] `npm run build`

## Execution checklist
- [x] Add Brave MCP server and CLI target config.
- [x] Update CLI default MCP manifest.
- [x] Update docs for setup/usage.
- [x] Run verification commands and record outcomes.

## Decision log
- 2026-02-15: Implement Brave search through existing MCP+mcporter path to stay aligned with current Butler architecture and OpenClaw-style extensibility.

## Result
Completed.

Behavior:
- Butler now defines a `brave-search` MCP server (`npx -y @modelcontextprotocol/server-brave-search`).
- Butler MCP targets now include `brave-search` alongside `codex`.
- `butler mcp init` produces a manifest that includes both starter targets.
- Docs now include Brave setup requirements and `BRAVE_API_KEY` guidance.

Verification outcomes:
- `npm run butler -- mcp list`: reports `codex` and `brave-search`.
- `npm run butler -- mcp sync --dry-run`: shows generate/emit commands for both targets.
- `npm run harness:check`: pass.
- `npm run build`: pass.

Residual risks / follow-up:
- No live Brave API call was executed in this plan; runtime success still depends on valid `BRAVE_API_KEY` on the worker host.
