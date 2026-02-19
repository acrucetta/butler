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

## TDD loop (minimal setup)

Use red/green/refactor with built-in node tests (via `tsx --test`):

```bash
# run all current tests
npm run test

# focus loop for worker policy/runtime work
npm run test:worker

# focus loop for telegram formatting work
npm run test:gateway
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
# optional: render final agent text as Telegram MarkdownV2 (default true)
TG_AGENT_MARKDOWNV2=true
# optional: explicit Pi runtime controls
PI_EXEC_MODE=rpc
PI_BINARY=pi
PI_PROVIDER=openrouter
PI_MODEL=moonshotai/kimi-k2.5
# optional: OpenClaw-style model profile routing + fallback
# PI_MODEL_ROUTING_FILE=.data/worker/model-routing.json
# optional: OpenClaw-style tool allow/deny policy
# PI_TOOL_POLICY_FILE=.data/worker/tool-policy.json
# optional: defaults are set by butler CLI when omitted
# PI_WORKSPACE=<repo-root>
# PI_SESSION_ROOT=<repo-root>/.data/worker/sessions
```

When `TG_AGENT_MARKDOWNV2=true`, prefer Telegram entities over standard Markdown:
- bold: `*bold*`
- italic: `_italic_` (not `*italic*`)
- underline: `__underline__`
- strikethrough: `~strike~`
- inline code: `` `code` ``
- fenced code blocks: ```` ```lang ... ``` ````
- blockquote: lines starting with `>`
- tables and horizontal rules are not native Telegram MarkdownV2 entities; the gateway falls back to a readable text/code-block rendering

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

## OpenClaw-style model routing + fallback

Worker supports profile-based model routing with fallback/cooldown behavior.

- Provide routing config at `PI_MODEL_ROUTING_FILE` (or `.data/worker/model-routing.json` if present).
- Use `config/model-routing.example.json` as a template.
- Route chains can differ by job kind (`task` vs `run`).
- On retryable failures, worker falls back to the next profile in route order.
- A failed profile is cooled down and deprioritized for subsequent jobs.
- Fallback is intentionally blocked when an attempt already produced output or tool activity to avoid duplicate side effects.
- Job metadata can pin a profile with `modelProfile`.

If no routing file exists, worker keeps legacy single-model behavior (`PI_PROVIDER` + `PI_MODEL`).

## OpenClaw-style tool policy (allow/deny layer)

Worker supports a lightweight, layered tool policy that is evaluated on tool invocation events.

- Scaffold defaults with one command:
  - `npm run butler -- policy init`
- Provide tool policy config at `PI_TOOL_POLICY_FILE` (or `.data/worker/tool-policy.json` if present).
- Use `config/tool-policy.example.json` as a template.
- Layer order is: `default` -> `byKind.<task|run>` -> `byProfile.<profileId>`.
- `deny` always wins over `allow`.
- If `allow` is set for a layer, it replaces prior allow patterns at that layer boundary.
- If no policy file exists, Butler keeps backward-compatible allow-all behavior.
- On denied tool invocation, worker logs the policy decision, aborts the active RPC attempt, and fails the job.

Pattern notes:
- Exact match: `read_file`
- Wildcards: `browser_*`, `*_write`, `*`

## Proactive runtime (heartbeats, cron, webhooks)

Orchestrator can proactively enqueue jobs from config-driven triggers.

- Set `ORCH_PROACTIVE_CONFIG_FILE` to a JSON config path (default: `.data/orchestrator/proactive-runtime.json`).
- Use `config/proactive-runtime.example.json` as a starting template.
- Trigger types:
  - `heartbeatRules`: enqueue every `everySeconds`.
  - `cronRules`: enqueue on exactly one schedule field:
    - `cron` (5-field cron)
    - `at` (one-shot ISO timestamp)
    - `everySeconds` (interval)
  - `cronRules` optional control fields:
    - `timezone` (for `cron` schedules)
    - `sessionTarget`: `main|isolated` (`isolated` uses `sessionKey=cron:<id>`)
    - `wakeMode`: `now|next-heartbeat` (`next-heartbeat` requires `sessionTarget=main`)
  - `webhooks`: `POST /v1/proactive/webhooks/:webhookId` with `x-webhook-secret`.
- Duplicate runs for the same trigger are skipped while a previous trigger job is still non-terminal.
- Recurring trigger retries use backoff on failures: `30s -> 1m -> 5m -> 15m -> 60m` (reset on success).
- Inspect runtime with `GET /v1/proactive/state` (gateway API key required).
- Inspect active config with `GET /v1/proactive/config`.
- Inspect run ledger with `GET /v1/proactive/runs`.
- Delivery modes for proactive rules:
  - `announce`: gateway auto-posts terminal result to target Telegram chat/thread.
  - `webhook`: gateway POSTs terminal result payload to `delivery.webhookUrl`.
  - `none`: no post-delivery action.
- OpenClaw-style tool surface for cron management:
  - `GET /v1/tools`
  - `POST /v1/tools/invoke` with:
    - `cron.list|cron.add|cron.update|cron.remove|cron.run`
    - `heartbeat.list|heartbeat.add|heartbeat.update|heartbeat.remove|heartbeat.run`
    - `proactive.runs`

Webhook example:

```bash
curl -X POST "http://127.0.0.1:8787/v1/proactive/webhooks/github-pr-review" \
  -H "content-type: application/json" \
  -H "x-webhook-secret: <webhook-secret>" \
  -d '{"action":"opened","repository":"example/repo"}'
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
