# Apple Health

## Purpose
Use this skill to process Apple Health exports and summarize trends.

## Constraints
- Treat all data as sensitive.
- Ask for explicit permission before persisting health facts to durable memory.

## Setup
- Point to export source with env vars listed in `skill.json`.
- Add MCP server and target entries in `skill.json`.
- Run `npm run butler -- skills sync`.
