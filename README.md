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
Voice notes, audio files, and photos are also treated as `/task` when media understanding is enabled (default: enabled).

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
In interactive mode, it also offers prebuilt skill onboarding (`readwise`, `gmail`, `google-calendar`, `hey-email`) so users can enable/configure them during first setup.
Interactive setup uses a step-by-step TUI Q&A flow (selects, toggles, and value prompts) similar to OpenClaw onboarding.

For automation (CI/provisioning), use non-interactive flags:

```bash
npm run butler -- setup --yes \
  --bot-token "<bot-token>" \
  --owner-ids "<telegram-user-id>" \
  --openai-api-key "<openai-api-key>" \
  --gateway-token "<16+ char secret>" \
  --worker-token "<16+ char secret>"
```

Optional skill onboarding flags for setup:
- `--skills readwise,gmail` to set the exact prebuilt skills enabled during setup.
- `--skill-env KEY=VALUE` (repeatable) to provide required skill env vars (for example `ACCESS_TOKEN` for Readwise).
- `--sync-selected-skills` to run MCP wrapper generation for selected MCP-backed skills during setup.
- `--flow quickstart|manual` to choose onboarding style (`quickstart` asks fewer questions).
- `--disable-media` to disable voice/photo understanding (enabled by default).
- when `gmail`/`google-calendar` are selected, setup checks `gog` auth status and can launch `gog auth login` interactively.
- if `gog` OAuth client credentials are missing, setup explains where to create them (Google Cloud Console) and can run `gog auth credentials set <credentials.json>`.
- setup can optionally write `GOG_ACCOUNT=<email>` to pin a default Google account for `gog`.

When setup detects an existing `.env` or skills config, interactive mode first asks whether to:
- keep current config and exit,
- modify current config,
- reset setup values and run onboarding again.

3. (Optional) Manual `.env` values if you prefer to edit directly:

```bash
ORCH_GATEWAY_TOKEN=your-strong-secret-16+chars
ORCH_WORKER_TOKEN=your-strong-secret-16+chars
TELEGRAM_BOT_TOKEN=<botfather-token>
TG_OWNER_IDS=<your-telegram-user-id>
# media understanding defaults to enabled and requires OPENAI_API_KEY
TG_MEDIA_ENABLED=true
OPENAI_API_KEY=<openai-api-key>
# optional media model/limits
# TG_MEDIA_STT_MODEL=gpt-4o-mini-transcribe
# TG_MEDIA_VISION_MODEL=gpt-5-mini
# TG_MEDIA_MAX_FILE_MB=20
# TG_MEDIA_VISION_MAX_FILE_MB=8
# TG_MEDIA_TRANSCRIPT_MAX_CHARS=6000
# TG_MEDIA_VISION_MAX_CHARS=4000
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

## Butler TUI (Ink)

For an OpenClaw-style runtime control surface, launch Butler's terminal UI:

```bash
npm run butler -- tui
```

Controls:
- `r`: refresh snapshot
- `m`: toggle doctor mode (`mock`/`rpc`)
- `i`: show/hide issue details
- `q`: quit

Optional flags:

```bash
npm run butler -- tui --mode rpc --refresh-ms 3000
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
    - `memory.search|memory.store|memory.ledger`
    - `memory.index|memory.status`

Memory tool notes:
- `memory.search` uses a local semantic index (vector hashing + lexical blend) across `memory/YYYY-MM-DD.md` and `MEMORY.md`.
- `memory.store` supports `scope=daily|durable`.
- `memory.ledger` reads recent writes from `.data/orchestrator/memory-ledger.jsonl` by default.
- `memory.index` forces index rebuild; `memory.status` reports chunk count + staleness.
- Optional env overrides:
  - `ORCH_MEMORY_ROOT` (default: repo root)
  - `ORCH_MEMORY_LEDGER_FILE` (default: `.data/orchestrator/memory-ledger.jsonl`)
  - `ORCH_MEMORY_INDEX_FILE` (default: `.data/orchestrator/memory-index.json`)

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
   The base repo includes starter `codex`; optional integrations should be added via `skills/*`.

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

### Brave Search MCP (via skills)

Brave Search is packaged as `skills/brave-search` and is not part of base MCP targets.
Enable it, set `BRAVE_API_KEY`, then run:

```bash
npm run butler -- skills enable brave-search
npm run butler -- skills sync
```

## Skills (simple local model)

Butler supports a simplified personal skill architecture inspired by OpenClaw:

- One local skills directory: `skills/<skill-id>/`
- Each skill folder contains:
  - `SKILL.md` (instructions/context)
  - `skill.json` (metadata, required env vars, optional MCP tool definitions)
- One config file: `.data/skills/config.json`

Skill CLI:

```bash
npm run butler -- skills init
npm run butler -- skills list
npm run butler -- skills add whoop
npm run butler -- skills setup whoop
npm run butler -- skills enable whoop
npm run butler -- skills disable whoop
npm run butler -- skills sync
```

Notes:
- `skills setup <id>` writes required skill env vars to `.env`.
- `skills sync` merges enabled skill MCP definitions with base `config/mcporter.json` + `config/mcp-clis.json`,
  writes generated files under `.data/skills/`, and runs MCP wrapper generation.
- `whoop` is prewired to `@alacore/whoop-mcp-server`; set `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI`,
  and `WHOOP_SCOPES` (must include `offline`) before enabling.
- `readwise` is prewired to `@readwise/readwise-mcp`; set `ACCESS_TOKEN`, then run:
  - `npm run butler -- skills enable readwise`
  - `npm run butler -- skills sync --target readwise`
- `gmail` and `google-calendar` follow OpenClaw's `gog` CLI workflow (not MCP wrapper generation):
  - install `gog` on the worker host
  - run `gog auth login` and `gog auth list`
  - for headless droplet usage, copy `~/.gog/` from a machine that completed login
- `hey-email` uses a HEY-to-Gmail bridge pattern because HEY has no stable public API/MCP path:
  - forward/screen HEY mail into Gmail with a dedicated label (for example `label:hey`)
  - query it through `gog gmail --query "label:hey ..."`

Worker runtime env options:
- `PI_SKILLS_CONFIG_FILE` (default: `.data/skills/config.json`)
- `PI_SKILLS_DIR` (default: `skills`)
- `PI_SKILLS_MODE` (`auto|always|off`)
- `PI_SKILLS_CONTEXT_WINDOW` (max skills included in prompt context)
- `PI_SKILLS_MAX_CHARS` (max prompt chars allocated to skills context)

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
- Media understanding for voice/audio/photo is enabled by default (`TG_MEDIA_ENABLED=true`) and requires `OPENAI_API_KEY`
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
