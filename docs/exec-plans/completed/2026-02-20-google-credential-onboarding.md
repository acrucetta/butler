# Google Credential Onboarding In Setup

- Owner: codex
- Status: completed
- Last updated: 2026-02-20

## Problem statement
Butler setup currently configures Google skills (`gmail`, `google-calendar`) without validating or guiding required `gog` credentials, causing confusing runtime failures later.

## Scope
- Add setup-time credential guidance/checks for Google skills.
- Validate `gog` binary presence.
- Check `gog auth list` for available logged-in accounts.
- Offer interactive `gog auth login` when credentials are missing.

## Non-goals
- Build a new OAuth implementation inside Butler.
- Replace `gog` with a custom Google integration.

## Constraints
- Keep non-interactive setup behavior compatible.
- Keep flow simple and actionable.

## Interfaces and contracts affected
- `butler setup` interactive onboarding flow.
- `README.md` setup documentation for Google skills.

## Acceptance criteria
- [x] Selecting Google skills in setup triggers a Google credential step.
- [x] Setup checks for `gog` and auth presence and reports clear warnings.
- [x] Interactive setup can invoke `gog auth login` and re-check auth status.

## Verification commands
- [x] `npm run harness:check`
- [x] `npm run build`
- [x] `npm run butler -- setup --help`
- [x] `npm run butler -- setup --yes --env-path /tmp/butler-google-test.env --skills-config-path /tmp/butler-google-skills.json --bot-token test-token --owner-ids 12345 --gateway-token 1234567890123456 --worker-token abcdefghijklmnop --skills gmail,google-calendar --skip-skill-sync --skip-doctor`
- [x] `npm run butler -- setup --env-path /tmp/butler-google-live.env --skills-config-path /tmp/butler-google-live-skills.json --skills gmail,google-calendar` (live PTY check)

## Execution checklist
- [x] Implement Google credential onboarding logic.
- [x] Surface warnings in setup summary output.
- [x] Update docs and record verification outcomes.

## Decision log
- 2026-02-20: Follow OpenClaw pattern by integrating with `gog` auth flow rather than handling Google OAuth directly.

## Result
Implemented Google credential onboarding in Butler setup following OpenClaw’s `gog`-based pattern.

Behavior:
- When `gmail` or `google-calendar` is selected, setup now checks for `gog` availability and current auth accounts.
- Interactive setup shows a dedicated Google credential step and can launch `gog auth login`.
- Setup re-checks accounts after login attempt and surfaces actionable warnings when credentials are still missing.
- Optional account pinning writes `GOG_ACCOUNT` in `.env` when an account is available.

Residual risks:
- `gog auth list` output parsing uses email extraction heuristics, which may need adjustment if upstream CLI output format changes.
