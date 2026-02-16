# Security

## Assets and Boundaries
- Secrets: `ORCH_GATEWAY_TOKEN`, `ORCH_WORKER_TOKEN`, Telegram bot token.
- Trusted control plane: `telegram-gateway` and `orchestrator`.
- Untrusted input: Telegram message bodies and command arguments.
- Isolated execution boundary: `vm-worker` runtime and optional RPC integration.

## Required Controls
- Secrets must be present and at least 16 characters where enforced.
- Unknown Telegram users must be paired before command execution.
- `/run` command must remain approval-gated and owner-only by default.
- API calls between services must be authenticated (`x-api-key` or bearer token).
- Keep prompt length and rate-limit protections enabled.
- Keep worker tool policy configured for least privilege by job kind/profile when risky tools are available.

## Security Review Triggers
- Any change to authz/authn logic.
- Any change to command execution policy.
- Any new external network integration.
- Any change that weakens secret handling or validation.

## Secure Change Checklist
- Validate untrusted input at boundaries.
- Document trust boundary changes in this file and `docs/ARCHITECTURE.md`.
- Add or update verification commands when behavior changes.
