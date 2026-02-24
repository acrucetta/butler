# Orchestrator

## Purpose
Use this skill to manage your own proactive schedule — cron jobs, heartbeat rules, and self-triggered routines.

## Available CLI tool: `orch`

Run `orch <command> [flags]` to manage proactive rules.

### Commands

#### Cron rules (scheduled tasks)
- `orch cron-list` — list all cron rules
- `orch cron-add --raw '<json>'` — create or update a cron rule
- `orch cron-remove --id <rule-id>` — delete a cron rule
- `orch cron-run --id <rule-id>` — trigger a cron rule immediately

#### Heartbeat rules (recurring check-ins)
- `orch heartbeat-list` — list all heartbeat rules
- `orch heartbeat-add --raw '<json>'` — create or update a heartbeat rule
- `orch heartbeat-remove --id <rule-id>` — delete a heartbeat rule
- `orch heartbeat-run --id <rule-id>` — trigger a heartbeat rule immediately

#### Other
- `orch proactive-runs [--limit N] [--triggerKey <key>]` — list recent proactive run history

### Cron rule JSON shape
```json
{
  "id": "unique-rule-id",
  "everySeconds": 86400,
  "prompt": "What the agent should do when this fires.",
  "delivery": { "mode": "announce" },
  "target": {
    "kind": "task",
    "chatId": "<telegram-chat-id>",
    "requesterId": "<telegram-chat-id>",
    "sessionKey": "proactive:cron:<rule-id>"
  }
}
```
Schedule options (exactly one required): `cron` (5-field), `at` (ISO timestamp), or `everySeconds`.

### Heartbeat rule JSON shape
```json
{
  "id": "unique-rule-id",
  "everySeconds": 1800,
  "prompt": "What the agent should do when this fires.",
  "delivery": { "mode": "announce" },
  "target": {
    "kind": "task",
    "chatId": "<telegram-chat-id>",
    "requesterId": "<telegram-chat-id>",
    "sessionKey": "proactive:heartbeat:<rule-id>"
  }
}
```

## Constraints
- The `target.chatId` and `target.requesterId` should be the owner's Telegram chat ID.
- Use `delivery.mode = "announce"` for Telegram delivery.
- Rule IDs should be descriptive kebab-case (e.g. `whoop-morning`, `daily-standup`).
- When the user asks you to schedule something, create a cron or heartbeat rule using this tool.
