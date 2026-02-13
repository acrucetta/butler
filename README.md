# Pi Telegram Agent (Personal OpenClaw-style stack)

Personal control plane for running a Pi agent through Telegram with VM-isolated execution.

## Components

- `apps/telegram-gateway`: Telegram bot, pairing, authorization, command UX
- `apps/orchestrator`: queue, approvals, job state, pause/resume control
- `apps/vm-worker`: worker that executes jobs in `mock` or Pi RPC mode
- `packages/contracts`: shared schemas and types
- `bin/pi-self.ts`: CLI wrapper (`doctor`, `up`)

## Architecture

```text
Telegram
  -> telegram-gateway
  -> orchestrator (queue + policy state)
  -> vm-worker (in sandbox VM)
  -> pi --mode rpc (in VM)
```

Detailed, living architecture doc (with Mermaid): `docs/ARCHITECTURE.md`

## Agent harness

This repo now includes a spec-driven harness for agent workflows:

- Entry map: `AGENTS.md`
- Planning flow: `docs/PLANS.md`
- Plan template: `docs/exec-plans/PLAN_TEMPLATE.md`
- Local workflow skill: `.agents/skills/spec-driven-execution/SKILL.md`
- OpenAI reference notes: `docs/references/openai-agent-harness-best-practices.md`

Run harness checks locally:

```bash
npm run harness:check
npm run verify:harness
```

## Telegram commands

- `/whoami`: show your Telegram user ID
- `/task <request>`: create and run a normal job
- `/run <command>`: create command job (approval required, owner-only by default)
- `/approve <jobId>`: approve pending job
- `/abort <jobId>`: abort job
- `/status <jobId>`: status details
- `/panic [status|on|off]`: pause/resume all execution (owner-only)
- `/pairings`: list pending pairings (owner-only)
- `/approvepair <code>`: approve pairing code (owner-only)

Plain text is treated as `/task`.

## One-command CLI

1. Install dependencies:

```bash
npm install
```

2. Create a root `.env` (or export vars in shell):

```bash
ORCH_GATEWAY_TOKEN=your-strong-secret-16+chars
ORCH_WORKER_TOKEN=your-strong-secret-16+chars
TELEGRAM_BOT_TOKEN=<botfather-token>
TG_OWNER_IDS=<your-telegram-user-id>
```

3. Validate setup:

```bash
npm run doctor
```

4. Start everything:

```bash
# safe local mode (worker mock)
npm run up

# or explicit
npm run pi-self -- up --mode mock

# real Pi mode (requires pi installed/authenticated in worker env)
npm run pi-self -- up --mode rpc
```

## Security/hardening defaults in this repo

- Mandatory strong API secrets (`ORCH_GATEWAY_TOKEN`, `ORCH_WORKER_TOKEN`, 16+ chars)
- Pairing required for unknown Telegram users
- Owner list required (`TG_OWNER_IDS`)
- `/run` requires approval and is owner-only by default
- Access controls:
  - owner can manage all jobs
  - non-owner can only view own jobs in same chat
  - abort by requester is configurable (`TG_ALLOW_REQUESTER_ABORT`)
- Built-in rate limiting (`TG_RATE_LIMIT_PER_MIN`) and prompt length cap (`TG_PROMPT_MAX_CHARS`)
- Global panic switch (`/panic on`) pauses worker claims
- Worker abort via heartbeat polling
- Event history capped per job to avoid unbounded growth

## VM deployment model

- Run `orchestrator` + `telegram-gateway` on your control host.
- Run `vm-worker` inside your sandbox VM.
- Point worker to orchestrator with `ORCH_BASE_URL`.
- Keep `ORCH_WORKER_TOKEN` only on worker VM and orchestrator.

## Important

- This is personal-use hardened, not enterprise hardened.
- For internet exposure, add TLS, reverse proxy auth, and webhook-mode Telegram setup.
- Real Pi mode requires `pi` installed and authenticated where `vm-worker` runs.
