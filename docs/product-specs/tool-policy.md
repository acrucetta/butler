# Tool Policy Layer Product Spec

Last updated: 2026-02-16

## Problem
Butler currently has approval and isolation controls but no explicit per-tool allow/deny layer. Operators need a simple policy to limit tool blast radius by job kind and model profile.

## User-observable behavior
- Worker can load tool policy config from `PI_TOOL_POLICY_FILE` (or `.data/worker/tool-policy.json` when present).
- Policy layers are evaluated in this order:
  - `default`
  - `byKind.task` / `byKind.run`
  - `byProfile.<profileId>`
- `deny` patterns always take precedence over `allow`.
- If no policy file exists, worker behavior remains allow-all (backward compatible).
- On denied tool usage:
  - worker emits a clear log event with tool name and reason
  - worker aborts the active RPC attempt
  - job fails (no fallback) because tool activity was detected

## Configuration contract
Top-level fields:
- `default`: `{ allow?: string[], deny?: string[] }`
- `byKind.task`: `{ allow?: string[], deny?: string[] }`
- `byKind.run`: `{ allow?: string[], deny?: string[] }`
- `byProfile.<profileId>`: `{ allow?: string[], deny?: string[] }`

Pattern matching:
- Exact string match: `read_file`
- `*` wildcard support: `browser_*`, `*_write`, `*`

## Safety constraints
- Policy evaluation remains worker-local and deterministic.
- Denied tools must be visible in job event logs for operator debugging.
- Existing gateway/orchestrator APIs and contracts are unchanged.

## Non-goals (v1)
- Runtime policy editing via Telegram commands.
- Orchestrator-side policy management APIs.
- Full OpenClaw profile lattice (`tools.profile`, `byProvider`) in this version.
