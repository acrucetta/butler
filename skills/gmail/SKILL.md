# Gmail

## Purpose
Use this skill to search, summarize, draft, and send email.

## Constraints
- Treat send/delete/archive actions as high-impact.
- Confirm recipients and subject before sending.

## Setup
- Provide OAuth credentials in env vars listed in `skill.json`.
- Add MCP server and target entries in `skill.json`.
- Run `npm run butler -- skills sync`.
