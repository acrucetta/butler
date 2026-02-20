# Readwise

## Purpose
Use this skill to retrieve highlights, metadata, and reading review context.

## Constraints
- Keep summaries concise and cite source titles when possible.
- Avoid exposing private highlights unless user explicitly asks.

## Setup
- Provide API token in env vars listed in `skill.json`.
- Add MCP server and target entries in `skill.json`.
- Run `npm run butler -- skills sync`.
