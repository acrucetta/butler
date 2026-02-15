# Pi Telegram Agent (Personal OpenClaw-style stack)

Personal control plane for running a Pi agent through Telegram with VM-isolated execution.

## Components

- `apps/telegram-gateway`: Telegram bot, pairing, authorization, command UX
- `apps/orchestrator`: queue, approvals, job state, pause/resume control
- `apps/vm-worker`: worker that executes jobs in `mock` or Pi RPC mode
- `packages/contracts`: shared schemas and types
- `bin/butler.mjs`: primary CLI (`setup`, `doctor`, `up`)
- `bin/pi-self.mjs`: legacy CLI alias (compatible with existing commands)
- `config/mcporter.json`: MCP server definitions consumed by `mcporter`
- `config/mcp-clis.json`: MCP-to-CLI generation manifest for `butler mcp sync`

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
- `/status`: show gateway + current chat session status
- `/status <jobId>`: status details
- `/context`: show current chat/thread session context key
- `/new [prompt]`: reset chat/thread session context (optional prompt runs in new context)
- `/reset [prompt]`: same as `/new`
- `/panic [status|on|off]`: pause/resume all execution (owner-only)
- `/pairings`: list pending pairings (owner-only)
- `/approvepair <code>`: approve pairing code (owner-only)

Plain text is treated as `/task`.

## Butler CLI (recommended)

1. Install dependencies:

```bash
npm install
```

2. Run the setup wizard:

```bash
npm run butler -- setup
```

This wizard walks you through Telegram + env setup and writes/updates `.env`.

For automation (CI/provisioning), use non-interactive flags:

```bash
npm run butler -- setup --yes \
  --bot-token "<bot-token>" \
  --owner-ids "<telegram-user-id>" \
  --gateway-token "<16+ char secret>" \
  --worker-token "<16+ char secret>"
```

3. (Optional) Manual `.env` values if you prefer to edit directly:

```bash
ORCH_GATEWAY_TOKEN=your-strong-secret-16+chars
ORCH_WORKER_TOKEN=your-strong-secret-16+chars
TELEGRAM_BOT_TOKEN=<botfather-token>
TG_OWNER_IDS=<your-telegram-user-id>
# optional: override session context store path
TG_SESSIONS_FILE=.data/gateway/sessions.json
# optional: only send final agent text in Telegram (default true)
TG_ONLY_AGENT_OUTPUT=true
# optional: explicit Pi runtime controls
PI_EXEC_MODE=rpc
PI_BINARY=pi
PI_PROVIDER=openrouter
PI_MODEL=moonshotai/kimi-k2.5
# optional: defaults are set by butler CLI when omitted
# PI_WORKSPACE=<repo-root>
# PI_SESSION_ROOT=<repo-root>/.data/worker/sessions
```

4. Validate setup:

```bash
npm run doctor
# or
npm run butler -- doctor
```

5. Start everything:

```bash
# safe local mode (worker mock)
npm run up

# or explicit
npm run butler -- up --mode mock

# real Pi mode (requires pi installed/authenticated in worker env)
npm run butler -- up --mode rpc
```

Legacy alias still works:

```bash
npm run pi-self -- up --mode mock
```

## OpenClaw-style personality + memory

The worker now mirrors OpenClaw's workspace-memory pattern:

- Workspace markdown files are memory source of truth.
- Personality file: `SOUL.md`
- Durable memory file: `MEMORY.md`
- Daily memory log: `memory/YYYY-MM-DD.md`
- Session transcript storage: `.data/worker/sessions`

At worker boot, Butler auto-creates `MEMORY.md` and today's daily memory file if missing.
It also appends a system prompt to Pi so the agent reads/writes these files like OpenClaw memory workflows.

You can override the injected policy text with:

```bash
PI_APPEND_SYSTEM_PROMPT="your custom memory policy"
```

## MCP CLI support (mcporter)

Use this to generate local MCP CLI wrappers similar to the OpenClaw+mcporter flow.

1. Initialize manifest files:

```bash
npm run butler -- mcp init
```

2. Add MCP servers in `config/mcporter.json` and generation targets in `config/mcp-clis.json`.
   The repo now includes starter `codex` and `brave-search` targets.

3. Generate wrappers:

```bash
npm run butler -- mcp sync
```

4. Inspect targets:

```bash
npm run butler -- mcp list
```

Generated artifacts default to:
- templates: `.data/mcp/templates`
- types: `.data/mcp/types`
- runnable wrappers: `.data/mcp/bin`

`butler up` and `vm-worker` prepend `.data/mcp/bin` to `PATH` so generated wrappers are available to runtime tools.

### Brave Search MCP

The `brave-search` target uses `@modelcontextprotocol/server-brave-search`.
Set `BRAVE_API_KEY` in `.env` (and on your production worker host), then run:

```bash
npm run butler -- mcp sync
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
- Session context is isolated per `chatId + threadId` and can be rotated with `/new` or `/reset`
- Telegram output defaults to agent-only text (`TG_ONLY_AGENT_OUTPUT=true`), suppressing queue/ops chatter
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
