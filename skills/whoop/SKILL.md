# Whoop

## Purpose
Use this skill to read wellness metrics and summarize readiness trends.

## Constraints
- Treat health metrics as sensitive personal data.
- Do not provide medical advice; stay descriptive.

## Setup
- In the WHOOP Developer dashboard, set your OAuth redirect URI (for example `http://localhost:8788/callback`).
- Set env vars listed in `skill.json`:
  - `WHOOP_CLIENT_ID`
  - `WHOOP_CLIENT_SECRET`
  - `WHOOP_REDIRECT_URI`
  - `WHOOP_SCOPES` (include `offline`; example: `offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout`)
- Enable and sync:
  - `npm run butler -- skills enable whoop`
  - `npm run butler -- skills sync`
- Run OAuth via WHOOP auth URL and exchange the auth code using the MCP tools:
  - `whoop_auth_url`
  - `whoop_exchange_token`
