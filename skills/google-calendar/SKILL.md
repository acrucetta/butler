# Google Calendar

## Purpose
Use this skill to read availability, create events, and update schedules.

## Constraints
- Confirm before creating, deleting, or moving events.
- Respect user timezone and use ISO timestamps.

## Setup
- Provide OAuth credentials in the env vars listed in `skill.json`.
- Add MCP server and target entries in `skill.json`.
- Run `npm run butler -- skills sync`.
