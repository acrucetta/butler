# Telegram Media Ingestion (Voice + Photo)

- Owner: codex
- Status: completed
- Last updated: 2026-02-21

## Problem statement
Butler's Telegram gateway only accepted `message:text`, so voice notes, audio files, and photos could not be used as task input.

## Scope
- Add Telegram gateway handlers for voice/audio/photo updates.
- Add media download + OpenAI transcription/vision conversion in gateway.
- Keep orchestrator/worker contracts unchanged by converting media into text prompts in gateway.
- Add setup + doctor support for media credentials.
- Update operator docs.

## Non-goals
- End-to-end binary attachment schema through orchestrator/worker.
- Non-OpenAI fallback providers.
- Video/document OCR workflows.

## Constraints
- Preserve pairing/owner/rate-limit/session guardrails.
- Keep gateway -> orchestrator -> worker boundaries intact.
- Fail fast with actionable errors when media credentials are missing.

## Interfaces and contracts affected
- `apps/telegram-gateway/src/index.ts`
- `bin/lib/butler-cli.mjs`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/product-specs/telegram-control-plane.md`

## Acceptance criteria
- [x] Paired users can send voice notes/audio files and gateway submits derived task prompts.
- [x] Paired users can send photos and gateway submits derived task prompts.
- [x] Setup/doctor enforce `OPENAI_API_KEY` when media processing is enabled.
- [x] Media is enabled by default and can be explicitly disabled.

## Verification commands
- [x] `npm --workspace apps/telegram-gateway run test`
- [x] `npm run build`
- [x] `npm run harness:check`

## Execution checklist
- [x] Implement media handlers and OpenAI integration in gateway.
- [x] Preserve existing command/pairing/rate-limit/session behaviors.
- [x] Add setup flags/prompts and doctor checks for media credentials.
- [x] Update docs for operator setup and behavior.

## Decision log
- 2026-02-21: Use a gateway media-to-text shim first to avoid orchestrator/worker schema churn.
- 2026-02-21: Keep OpenAI integration in v1 for minimal moving parts; add provider fallback later.
- 2026-02-21: Enable media by default and collect API credentials early in setup flow.

## Result
Gateway now accepts Telegram voice/audio/photo messages, converts them into text context, and submits normal task jobs.

Residual risks and follow-up:
- Media understanding currently depends on OpenAI API availability and model behavior.
- Large file handling is size-capped but not yet streamed/chunked.
- Provider fallback support (Deepgram/Groq/local CLI) is future work.
