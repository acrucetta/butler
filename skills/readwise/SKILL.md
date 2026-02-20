# Readwise

## Purpose
Use this skill to retrieve highlights, metadata, and reading review context.

## Constraints
- Keep summaries concise and cite source titles when possible.
- Avoid exposing private highlights unless user explicitly asks.

## Setup
- Set `ACCESS_TOKEN` to your Readwise access token.
- Enable and sync:
  - `npm run butler -- skills enable readwise`
  - `npm run butler -- skills sync --target readwise`
