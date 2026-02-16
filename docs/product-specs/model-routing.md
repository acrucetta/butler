# Model Routing and Fallback Product Spec

Last updated: 2026-02-16

## Problem
A single fixed model/provider configuration makes worker reliability and cost control brittle. Butler needs profile-based routing and fallback similar to OpenClaw-style multi-model operation.

## User-observable behavior
- Worker supports multiple model profiles loaded from `PI_MODEL_ROUTING_FILE` (or `.data/worker/model-routing.json` when present).
- Jobs are routed by kind (`task` vs `run`) using ordered route chains.
- Jobs may force a single profile using metadata key `modelProfile`.
- On retryable failures, worker falls back to the next profile in route order.
- Failed profiles enter cooldown and are deprioritized for subsequent jobs until cooldown expires.
- If no routing file exists, worker keeps legacy single-model mode from `PI_PROVIDER` + `PI_MODEL`.

## Safety constraints
- Fallback is disabled when an attempt produced partial text output or any tool activity, to avoid duplicated side effects.
- Fallback is disabled when abort has been requested.
- Unknown `modelProfile` metadata causes the job to fail with a clear error.

## Configuration contract
Top-level fields:
- `profiles[]`: model profiles.
- `routes.default[]`, `routes.task[]`, `routes.run[]`: ordered profile IDs.
- `maxAttemptsPerJob`: max attempts from selected route (capped internally).
- `retryableErrorPatterns[]`: case-insensitive substrings treated as retryable.

Profile fields:
- `id` (required)
- `provider` (optional)
- `model` (optional)
- `cooldownSeconds` (optional)
- `appendSystemPrompt` (optional)
- `env` (optional static env overrides)
- `envFrom` (optional target->source environment variable map)

## Non-goals (v1)
- Telegram command UX for runtime profile switching.
- Provider-specific health probes and smart latency-based selection.
- Orchestrator-side model policy management.
