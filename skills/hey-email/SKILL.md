# HEY Email

## Purpose
Use this skill when the user asks for HEY inbox triage, summaries, or follow-up drafting.

## Constraints
- HEY does not provide a stable public API/MCP integration path.
- Confirm before any send/archive/delete actions executed through bridged mailboxes.
- Keep HEY-sensitive data scoped to the specific user request.

## Setup
- Configure HEY forwarding or screening rules to copy relevant messages into Gmail.
- Apply a dedicated Gmail label for bridged mail (for example, `label:hey`).
- Enable and configure the `gmail` skill (`gog` auth) on the worker host.

## Common Commands
- `gog gmail --query "label:hey newer_than:7d" --limit 25`
- `gog gmail --query "label:hey from:important@" --thread`
- `gog gmail --query "label:hey is:unread" --full`
