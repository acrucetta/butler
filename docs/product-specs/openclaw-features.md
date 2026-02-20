# OpenClaw Feature Candidates for Butler

Last updated: 2026-02-16

## Scope

This document lists publicly advertised OpenClaw capabilities and maps them to possible Butler roadmap items.

Source basis:
- OpenClaw website (`open-claw.org`)
- OpenClaw docs site (`openclawdoc.com`)

## Feature List (From OpenClaw Website/Docs)

## 1) Multi-channel messaging gateway (50+ channels)
- What OpenClaw advertises:
  - One agent instance connected across many channels (Telegram, WhatsApp, Discord, Slack, Signal, iMessage, WeChat, Matrix, etc.).
- Why it matters for Butler:
  - Butler is currently Telegram-centric; this would expand reach without changing core orchestrator/worker logic.
- Suggested Butler version:
  - Add a channel adapter layer with shared auth/pairing/session policies.
- Priority suggestion:
  - High.

## 2) Proactive runtime (heartbeats, cron, webhook-triggered work)
- What OpenClaw advertises:
  - Background proactive actions with heartbeats, cron jobs, and webhook-driven automation.
- Why it matters for Butler:
  - Butler currently executes user-triggered jobs; proactive flows would enable monitoring and autonomous routines.
- Suggested Butler version:
  - Add scheduler + webhook ingress in orchestrator, with explicit allowlists and owner approval controls.
- Priority suggestion:
  - High.

## 3) Persistent memory/context as first-class feature
- What OpenClaw advertises:
  - Durable memory across sessions and long-term personalization.
- Why it matters for Butler:
  - Butler already has `SOUL.md`/`MEMORY.md`/daily memory files; this can be strengthened with memory quality checks and retrieval policy.
- Suggested Butler version:
  - Add memory write policy tests, conflict resolution, and optional vector index over markdown memory.
- Priority suggestion:
  - Medium-high.

## 4) Browser automation and data extraction
- What OpenClaw advertises:
  - Browser control for form-filling, navigation, and extraction.
- Why it matters for Butler:
  - Enables practical workflows (bookings, status checks, web ops) from chat.
- Suggested Butler version:
  - Introduce a browser worker capability behind strict policy gates (`/run`-style approval by default).
- Priority suggestion:
  - High.

## 5) Skills ecosystem + marketplace
- What OpenClaw advertises:
  - Large community skill registry (ClawHub) and custom skill authoring.
- Why it matters for Butler:
  - Butler already supports local skills/workflows via repo patterns; marketplace-like packaging would improve extensibility.
- Suggested Butler version:
  - Start with signed local skill manifests and review workflow before any public registry model.
- Priority suggestion:
  - Medium.
- Security note:
  - Keep strict provenance and permission controls if adding third-party skills.

## 6) Secure sandbox with fine-grained permissions
- What OpenClaw advertises:
  - Isolated skill execution and permission review.
- Why it matters for Butler:
  - Butler already has VM isolation + approval semantics; fine-grained per-tool scopes would reduce blast radius further.
- Suggested Butler version:
  - Add explicit tool capability policy (filesystem/network/command classes) per job type.
- Priority suggestion:
  - High.

## 7) Model-agnostic routing (cloud + local models via Ollama)
- What OpenClaw advertises:
  - Multi-model support and local-model option.
- Why it matters for Butler:
  - Butler has provider/model envs now; dynamic routing would improve cost/latency/reliability control.
- Suggested Butler version:
  - Add model routing policies by task class (cheap model for status, stronger model for coding/review).
- Priority suggestion:
  - Medium-high.

## 8) Built-in web search tooling
- What OpenClaw advertises:
  - Web-search configuration as a built-in capability.
- Why it matters for Butler:
  - Complements research-heavy tasks and improves accuracy for time-sensitive requests.
- Suggested Butler version:
  - Standardize search provider config in worker and enforce citation policy in agent responses.
- Priority suggestion:
  - Medium.

## 9) Agent recipes/workflow templates (example: PR code review bot)
- What OpenClaw advertises:
  - Cookbook-style deployable workflows (e.g., GitHub webhook PR review).
- Why it matters for Butler:
  - Reusable templates reduce setup friction and provide tested automation blueprints.
- Suggested Butler version:
  - Add `docs/cookbook` with runnable “butler recipes” tied to verification commands.
- Priority suggestion:
  - Medium.

## 10) Channel-native UX features (mentions, slash commands, rich replies)
- What OpenClaw advertises:
  - Platform-specific interaction modes (e.g., Discord mention modes, slash commands, rich message types).
- Why it matters for Butler:
  - Improves usability once Butler expands beyond Telegram.
- Suggested Butler version:
  - Define channel capability matrix and normalize fallback behavior.
- Priority suggestion:
  - Medium.

## Candidate Prioritization (Suggested)

If we optimize for near-term value in Butler:
1. Proactive runtime (heartbeats/cron/webhooks).
2. Browser automation with explicit approvals.
3. Fine-grained sandbox/tool policy.
4. Multi-channel adapter architecture.
5. Stronger memory quality/retrieval policy.

## Sources

- https://open-claw.org/
- https://openclawdoc.com/
- https://openclawdoc.com/docs/intro/
- https://openclawdoc.com/docs/skills/clawhub/
- https://openclawdoc.com/docs/channels/whatsapp/
- https://openclawdoc.com/docs/channels/discord/
- https://openclawdoc.com/docs/channels/matrix/
- https://openclawdoc.com/docs/models/local-models/
- https://www.openclawdoc.com/en/docs/configuration/
- https://openclawdoc.com/docs/cookbook/code-review-bot/
