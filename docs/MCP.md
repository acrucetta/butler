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
- `brave-search` is provided as an optional skill package in `skills/brave-search` and merged through `butler skills sync`.

## Brave Search setup

1. Create a Brave Search API key (Brave "Data for Search" plan).
2. Set `BRAVE_API_KEY` in your `.env` (and in the worker host environment for production).
3. Enable the skill and regenerate wrappers:

```bash
npm run butler -- skills enable brave-search
npm run butler -- skills sync
```

4. Confirm targets:

```bash
npm run butler -- mcp list
```

## Readwise setup (via skills + MCP)

1. Set `ACCESS_TOKEN` in `.env` (and worker runtime environment for production).
2. Enable + sync:

```bash
npm run butler -- skills enable readwise
npm run butler -- skills sync --target readwise
```

3. Confirm target:

```bash
npm run butler -- mcp list
```

Setup wizard shortcut:

```bash
npm run butler -- setup --skills readwise,gmail --skill-env ACCESS_TOKEN=<token>
```

## Google Calendar + Gmail setup (OpenClaw `gog` CLI)

Google integrations in this repo follow OpenClaw's Google CLI path (`gog`) instead of MCP wrapper generation.

1. Install `gog` on your worker host.
2. Authenticate:

```bash
gog auth login
gog auth list
```

3. For headless droplet deployment, perform login on a browser-capable machine and copy `~/.gog/` to the droplet user.
4. Enable skill context packages:

```bash
npm run butler -- skills enable gmail
npm run butler -- skills enable google-calendar
```

5. Verify commands:

```bash
gog gmail --query "in:inbox newer_than:7d" --limit 20
gog cal --days 7
```

Setup wizard shortcut:

```bash
npm run butler -- setup --skills gmail,google-calendar
```

## HEY email setup (bridge pattern)

HEY currently has no stable public API/MCP path. Use HEY forwarding/screening into Gmail and query via `gog gmail`.

1. Forward or screen HEY mail to Gmail with a dedicated label (for example `label:hey`).
2. Enable skills:

```bash
npm run butler -- skills enable hey-email
npm run butler -- skills enable gmail
```

3. Query bridged HEY mail:

```bash
gog gmail --query "label:hey is:unread" --limit 25
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
