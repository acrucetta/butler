# MCP CLI Integration (Phase 1)

## Problem statement

The repo needs a first-class path to consume MCP servers and expose them as local CLIs, aligned with OpenClaw-style `mcporter` workflows.

## Scope

- Add `butler mcp` commands to manage MCP CLI generation.
- Store durable generation config in versioned files.
- Generate wrapper binaries for MCP targets via `mcporter`.
- Make generated wrappers discoverable at worker runtime.

## Non-goals

- Native long-lived MCP runtime inside `vm-worker`.
- Policy engine for MCP tool allow/deny.
- Automated remote install of MCP servers.

## Contracts

- `config/mcporter.json`: MCP server definitions (`mcporter` input).
- `config/mcp-clis.json`: generation manifest (`mcporter` target mapping).
- Generated outputs in `.data/mcp/*` are local runtime artifacts.

## CLI surface

- `butler mcp init`
- `butler mcp list`
- `butler mcp sync`
- `butler skills sync` (merges enabled skills into generated MCP manifests, then runs sync)

## Starter targets

- `codex` is preconfigured:
  - Server config in `config/mcporter.json`
  - CLI target in `config/mcp-clis.json`
  - Selector: `codex`
- `brave-search` is preconfigured:
  - Server package: `@modelcontextprotocol/server-brave-search`
  - CLI target selector: `brave-search`
  - Requires runtime `BRAVE_API_KEY` in the worker environment

## Brave Search setup

1. Create a Brave Search API key (Brave "Data for Search" plan).
2. Set `BRAVE_API_KEY` in your `.env` (and in the worker host environment for production).
3. Regenerate wrappers:

```bash
npm run butler -- mcp sync
```

4. Confirm targets:

```bash
npm run butler -- mcp list
```

## Acceptance criteria

- Running `butler mcp list` shows configured targets.
- Running `butler mcp sync` invokes `mcporter generate-cli` for each target.
- Optional type generation runs via `mcporter emit-ts` unless disabled.
- `butler up` and `vm-worker` include `.data/mcp/bin` on `PATH`.
- Generated wrapper launchers execute template CLIs through `tsx`.

## Verification commands

```bash
npm run butler -- mcp list
npm run butler -- mcp sync --dry-run
npm run butler -- mcp init --config-path /tmp/butler-mcp-clis.json --force
npm run butler -- skills sync --dry-run
```
