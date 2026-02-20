# Google Credentials Bootstrap Guidance

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
When `gog` OAuth client credentials are missing, Butler setup currently warns about missing Google auth accounts but does not explain how to obtain and set OAuth credentials, causing onboarding dead-ends.

## Scope
- Detect missing `gog auth credentials`.
- Provide concrete setup guidance in warnings.
- Add interactive credential bootstrap step (`gog auth credentials set <file>`).

## Non-goals
- Implement direct Google OAuth inside Butler.
- Replace `gog` credential/auth model.

## Constraints
- Keep non-interactive setup compatible.
- Maintain simple operator flow.

## Interfaces and contracts affected
- `butler setup` Google credential onboarding.
- README setup guidance.

## Acceptance criteria
- [x] Setup clearly tells operators where to get credentials and how to set them.
- [x] Interactive setup can capture credentials file path and run `gog auth credentials set`.
- [x] Existing `gog auth login` flow still works after credentials setup.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`
- [x] `npm run butler -- setup --help`
- [x] `npm run butler -- setup --yes --env-path /tmp/butler-google-test2.env --skills-config-path /tmp/butler-google-skills2.json --bot-token test-token --owner-ids 12345 --gateway-token 1234567890123456 --worker-token abcdefghijklmnop --skills gmail,google-calendar --skip-skill-sync --skip-doctor`
- [x] `npm run butler -- setup --env-path /tmp/butler-google-live3.env --skills-config-path /tmp/butler-google-live3-skills.json --skills gmail,google-calendar` (live PTY check)

## Execution checklist
- [x] Add `gog` credential presence check and bootstrap helper.
- [x] Update Google credential onboarding prompts/warnings.
- [x] Update docs and verification notes.

## Decision log
- 2026-02-20: Keep guidance directly in setup flow instead of deferring users to external docs first.

## Result
Implemented first-class bootstrap guidance when `gog` OAuth client credentials are missing.

Behavior:
- Setup now checks `gog auth credentials list` before account login checks.
- If credentials are missing, setup provides explicit Google Cloud Console instructions.
- Interactive setup can prompt for `credentials.json` path and run `gog auth credentials set`.
- If credentials remain missing, setup reports concrete next-step commands in summary warnings.

Residual risks:
- Guidance assumes standard Google Cloud menu naming for OAuth Desktop client creation.
