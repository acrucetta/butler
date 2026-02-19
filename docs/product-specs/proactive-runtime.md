# Proactive Runtime Product Spec

Last updated: 2026-02-16

## Problem
Butler can only execute user-initiated jobs. Operators need autonomous trigger paths for recurring checks and event-driven automations.

## User-observable behavior
- Orchestrator supports three proactive trigger types:
  - heartbeat interval rules
  - cron manager rules with one schedule field:
    - `cron` (5-field minute expressions)
    - `at` (one-shot ISO timestamp)
    - `everySeconds` (interval)
  - webhook rules
- Recurring trigger failures apply retry backoff (`30s`, `1m`, `5m`, `15m`, `60m`) and reset on success.
- Cron rules support runtime execution semantics:
  - `sessionTarget`: `main|isolated`
  - `wakeMode`: `now|next-heartbeat` (`next-heartbeat` for `main` sessions)
  - `timezone` for cron pattern evaluation.
- Every trigger enqueues a normal Butler job with metadata identifying trigger kind/id.
- Duplicate trigger runs are skipped while a previous run for the same trigger is still non-terminal.
- Webhook triggers require a matching per-webhook secret (`x-webhook-secret`).
- Operators can inspect proactive runtime state via `GET /v1/proactive/state`.
- Operators can inspect current rule config (without webhook secrets) via `GET /v1/proactive/config`.
- Gateway can drain delivery outbox via:
  - `GET /v1/proactive/deliveries/pending`
  - `POST /v1/proactive/deliveries/:jobId/ack`
- Operators can inspect proactive run ledger via `GET /v1/proactive/runs`.
- Orchestrator exposes OpenClaw-style tool invocation endpoint for cron management:
  - `GET /v1/tools`
  - `POST /v1/tools/invoke` for `cron.list|add|update|remove|run`, `heartbeat.list|add|update|remove|run`, and `proactive.runs`
- Proactive rules support delivery modes:
  - `announce` (auto post to Telegram target when terminal)
  - `webhook` (POST terminal payload to `delivery.webhookUrl`)
  - `none` (no post-delivery action)

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
- `cronRules[]`: `{ id, (cron|at|everySeconds), timezone?, sessionTarget, wakeMode, prompt, delivery, target }`
- `webhooks[]`: `{ id, secret, prompt, includePayloadInPrompt, target }`
- `webhookPayloadMaxChars`: max serialized payload chars appended to webhook prompt

`target` fields:
- `kind`: `task` or `run`
- `chatId`, `threadId?`, `requesterId`, `sessionKey`
- `requiresApproval`
- `metadata?`
- `delivery`: `{ mode: announce|webhook|none, webhookUrl? }`

## Non-goals (v1)
- Provider-specific webhook signature validation.
- Persistent scheduler offsets across orchestrator restarts.
