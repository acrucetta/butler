# Proactive Runtime Product Spec

Last updated: 2026-02-16

## Problem
Butler can only execute user-initiated jobs. Operators need autonomous trigger paths for recurring checks and event-driven automations.

## User-observable behavior
- Orchestrator supports three proactive trigger types:
  - heartbeat interval rules
  - cron schedule rules (5-field minute-level expressions)
  - webhook rules
- Every trigger enqueues a normal Butler job with metadata identifying trigger kind/id.
- Duplicate trigger runs are skipped while a previous run for the same trigger is still non-terminal.
- Webhook triggers require a matching per-webhook secret (`x-webhook-secret`).
- Operators can inspect proactive runtime state via `GET /v1/proactive/state`.

## Authorization and safety
- Triggered jobs use explicit configured target identity (`chatId`, `requesterId`, `sessionKey`) and can require approval.
- Webhooks without a configured id return `404`.
- Webhooks with invalid secret return `401`.

## Configuration contract
Config file path is set by `ORCH_PROACTIVE_CONFIG_FILE`.

Top-level fields:
- `enabled`: boolean
- `tickMs`: scheduler tick interval
- `heartbeatRules[]`: `{ id, everySeconds, prompt, target }`
- `cronRules[]`: `{ id, cron, prompt, target }`
- `webhooks[]`: `{ id, secret, prompt, includePayloadInPrompt, target }`
- `webhookPayloadMaxChars`: max serialized payload chars appended to webhook prompt

`target` fields:
- `kind`: `task` or `run`
- `chatId`, `threadId?`, `requesterId`, `sessionKey`
- `requiresApproval`
- `metadata?`

## Non-goals (v1)
- Runtime management via Telegram commands.
- Provider-specific webhook signature validation.
- Persistent scheduler offsets across orchestrator restarts.
