import type { Job } from "@pi-self/contracts";
import { isTerminalStatus } from "@pi-self/contracts";
import { Bot } from "grammy";
import { OrchestratorClient } from "./orchestrator-client.js";
import { PairingStore } from "./pairing-store.js";
import { SessionStore } from "./session-store.js";
import { toTelegramMarkdownV2 } from "./telegram-markdown.js";

class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  consume(key: string): { allowed: boolean; retryAfterMs: number } {
    if (this.limit <= 0) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const current = this.buckets.get(key) ?? [];
    const recent = current.filter((ts) => ts >= cutoff);

    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now);
      this.buckets.set(key, recent);
      return { allowed: false, retryAfterMs };
    }

    recent.push(now);
    this.buckets.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

const botToken = requireEnv("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN);
const orchestratorBaseUrl = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8787";
const gatewayToken = requireSecret("ORCH_GATEWAY_TOKEN", process.env.ORCH_GATEWAY_TOKEN);
const jobPollMs = parsePositiveInt(process.env.TG_JOB_POLL_MS, 2_000);
const promptMaxChars = parsePositiveInt(process.env.TG_PROMPT_MAX_CHARS, 8_000);
const rateLimitPerMinute = parsePositiveInt(process.env.TG_RATE_LIMIT_PER_MIN, 12);
const runOwnerOnly = parseBoolean(process.env.TG_RUN_OWNER_ONLY, true);
const approveOwnerOnly = parseBoolean(process.env.TG_APPROVE_OWNER_ONLY, true);
const allowRequesterAbort = parseBoolean(process.env.TG_ALLOW_REQUESTER_ABORT, true);
const notifyToolEvents = parseBoolean(process.env.TG_NOTIFY_TOOL_EVENTS, false);
const onlyAgentOutput = parseBoolean(process.env.TG_ONLY_AGENT_OUTPUT, true);
const agentMarkdownV2 = parseBoolean(process.env.TG_AGENT_MARKDOWNV2, true);
const proactiveDeliveryPollMs = parsePositiveInt(process.env.TG_PROACTIVE_DELIVERY_POLL_MS, 3_000);
const owners = splitCsv(process.env.TG_OWNER_IDS ?? "");
const allowFrom = splitCsv(process.env.TG_ALLOW_FROM ?? "");
const pairingsFile = process.env.TG_PAIRINGS_FILE ?? ".data/gateway/pairings.json";
const sessionsFile = process.env.TG_SESSIONS_FILE ?? ".data/gateway/sessions.json";

if (owners.length === 0) {
  throw new Error("TG_OWNER_IDS must include at least one Telegram user ID");
}

const bot = new Bot(botToken);
const orchestrator = new OrchestratorClient(orchestratorBaseUrl, gatewayToken);
const pairings = new PairingStore(pairingsFile, owners, allowFrom);
const sessions = new SessionStore(sessionsFile);
const activeTrackers = new Set<string>();
const rateLimiter = new SlidingWindowRateLimiter(rateLimitPerMinute, 60_000);

bot.on("message:text", async (ctx) => {
  try {
    const text = ctx.message.text.trim();
    const fromId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat.id);
    const threadId = ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined;

    if (!fromId) {
      return;
    }

    if (text === "/whoami") {
      await ctx.reply(`telegram_user_id=${fromId}`);
      return;
    }

    if (!pairings.isAllowed(fromId)) {
      await handleUnpairedMessage(ctx, fromId);
      return;
    }

    if (text === "/start" || text === "/help") {
      await ctx.reply(helpText());
      return;
    }

    if (text === "/pairings") {
      if (!pairings.isOwner(fromId)) {
        await ctx.reply("Owner-only command.");
        return;
      }

      const pending = pairings.listPending();
      if (pending.length === 0) {
        await ctx.reply("No pending pairing requests.");
        return;
      }

      const summary = pending
        .map((entry) => `code=${entry.code} user=${entry.userId} created=${entry.createdAt}`)
        .join("\n");
      await ctx.reply(`Pending pairings:\n${summary}`);
      return;
    }

    if (text.startsWith("/approvepair ")) {
      if (!pairings.isOwner(fromId)) {
        await ctx.reply("Owner-only command.");
        return;
      }

      const code = text.slice("/approvepair ".length).trim().toUpperCase();
      if (!code) {
        await ctx.reply("Usage: /approvepair <CODE>");
        return;
      }

      const approved = pairings.approveCode(code);
      if (!approved) {
        await ctx.reply(`No pending pairing found for code ${code}.`);
        return;
      }

      await ctx.reply(`Approved user ${approved.userId}`);
      return;
    }

    if (text === "/panic" || text.startsWith("/panic ")) {
      if (!pairings.isOwner(fromId)) {
        await ctx.reply("Owner-only command.");
        return;
      }

      await handlePanic(ctx, text);
      return;
    }

    if (text === "/status") {
      await handleStatusSummary(ctx, chatId, threadId);
      return;
    }

    if (text.startsWith("/status ")) {
      const jobId = text.slice("/status ".length).trim();
      if (!jobId) {
        await ctx.reply("Usage: /status <jobId>");
        return;
      }

      await handleStatus(ctx, fromId, chatId, jobId);
      return;
    }

    if (text.startsWith("/approve ")) {
      const jobId = text.slice("/approve ".length).trim();
      if (!jobId) {
        await ctx.reply("Usage: /approve <jobId>");
        return;
      }

      await handleApproveJob(ctx, fromId, jobId);
      return;
    }

    if (text.startsWith("/abort ")) {
      const jobId = text.slice("/abort ".length).trim();
      if (!jobId) {
        await ctx.reply("Usage: /abort <jobId>");
        return;
      }

      await handleAbortJob(ctx, fromId, chatId, jobId);
      return;
    }

    if (text === "/context") {
      await handleContext(ctx, chatId, threadId);
      return;
    }

    if (text === "/new" || text.startsWith("/new ")) {
      const remainder = text.slice("/new".length).trim();
      await handleResetSession(ctx, fromId, chatId, threadId, remainder);
      return;
    }

    if (text === "/reset" || text.startsWith("/reset ")) {
      const remainder = text.slice("/reset".length).trim();
      await handleResetSession(ctx, fromId, chatId, threadId, remainder);
      return;
    }

    if (text.startsWith("/task ")) {
      const prompt = text.slice("/task ".length).trim();
      if (!prompt) {
        await ctx.reply("Usage: /task <request>");
        return;
      }

      const limited = await enforcePromptPolicies(ctx, fromId, prompt);
      if (!limited) {
        return;
      }

      await submitJob(ctx, prompt, "task", false);
      return;
    }

    if (text.startsWith("/run ")) {
      if (runOwnerOnly && !pairings.isOwner(fromId)) {
        await ctx.reply("/run is owner-only in this deployment.");
        return;
      }

      const command = text.slice("/run ".length).trim();
      if (!command) {
        await ctx.reply("Usage: /run <command>");
        return;
      }

      const limited = await enforcePromptPolicies(ctx, fromId, command);
      if (!limited) {
        return;
      }

      await submitJob(ctx, command, "run", true);
      return;
    }

    if (text.startsWith("/")) {
      await ctx.reply(helpText());
      return;
    }

    const limited = await enforcePromptPolicies(ctx, fromId, text);
    if (!limited) {
      return;
    }

    await submitJob(ctx, text, "task", false);
  } catch (error) {
    await ctx.reply(`Request failed: ${formatError(error)}`);
  }
});

bot.catch((error) => {
  console.error("[gateway] bot error", error.error);
});

await bot.start({
  onStart: (botInfo) => {
    console.log(`[gateway] bot started @${botInfo.username}`);
    console.log(`[gateway] owners=${owners.join(",")}`);
  }
});

void runProactiveDeliveryLoop();

async function handleUnpairedMessage(ctx: any, fromId: string): Promise<void> {
  if (ctx.chat.type !== "private") {
    return;
  }

  const code = pairings.issuePairingCode(fromId);
  await ctx.reply([
    "You are not paired with this agent yet.",
    `Your Telegram user id: ${fromId}`,
    `Pairing code: ${code}`,
    "Ask the owner to run /pairings then /approvepair <CODE>."
  ].join("\n"));
}

async function handlePanic(ctx: any, text: string): Promise<void> {
  const arg = text === "/panic" ? "status" : text.slice("/panic ".length).trim().toLowerCase();

  if (arg === "status") {
    const admin = await orchestrator.getAdminState();
    await ctx.reply(renderAdminState(admin));
    return;
  }

  if (arg === "on") {
    const admin = await orchestrator.pause("panic command from Telegram owner");
    await ctx.reply(`Panic enabled. ${renderAdminState(admin)}`);
    return;
  }

  if (arg === "off") {
    const admin = await orchestrator.resume();
    await ctx.reply(`Panic disabled. ${renderAdminState(admin)}`);
    return;
  }

  await ctx.reply("Usage: /panic [status|on|off]");
}

async function handleStatusSummary(ctx: any, chatId: string, threadId?: string): Promise<void> {
  const admin = await orchestrator.getAdminState();
  const session = sessions.getSession(chatId, threadId);

  await ctx.reply([
    "Gateway status:",
    renderAdminState(admin),
    renderSessionSummary(session.chatId, session.threadId, session.sessionKey, session.generation, session.lastResetAt),
    `active_trackers: ${activeTrackers.size}`
  ].join("\n"));
}

async function handleContext(ctx: any, chatId: string, threadId?: string): Promise<void> {
  const session = sessions.getSession(chatId, threadId);
  await ctx.reply([
    "Session context:",
    renderSessionSummary(session.chatId, session.threadId, session.sessionKey, session.generation, session.lastResetAt),
    `created: ${session.createdAt}`,
    `updated: ${session.updatedAt}`,
    `route: ${session.routeKey}`
  ].join("\n"));
}

async function handleResetSession(
  ctx: any,
  fromId: string,
  chatId: string,
  threadId: string | undefined,
  promptAfterReset: string
): Promise<void> {
  const session = sessions.resetSession(chatId, threadId);
  await ctx.reply([
    "Session reset.",
    renderSessionSummary(session.chatId, session.threadId, session.sessionKey, session.generation, session.lastResetAt)
  ].join("\n"));

  if (!promptAfterReset) {
    return;
  }

  const limited = await enforcePromptPolicies(ctx, fromId, promptAfterReset);
  if (!limited) {
    return;
  }

  await submitJob(ctx, promptAfterReset, "task", false);
}

async function submitJob(ctx: any, prompt: string, kind: "task" | "run", requiresApproval: boolean): Promise<void> {
  const fromId = String(ctx.from?.id ?? "");
  const chatId = String(ctx.chat.id);
  const threadId = ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined;
  const session = sessions.touchSession(chatId, threadId);
  const sessionKey = session.sessionKey;

  const admin = await orchestrator.getAdminState();
  const job = await orchestrator.createJob({
    kind,
    prompt,
    channel: "telegram",
    chatId,
    threadId,
    requesterId: fromId,
    sessionKey,
    requiresApproval,
    metadata: kind === "run" ? { command: prompt } : undefined
  });

  if (requiresApproval) {
    await sendThreadMessage(chatId, threadId, `Pending approval. Use /approve ${job.id} to run it.`);
  } else if (!onlyAgentOutput) {
    await sendThreadMessage(chatId, threadId, [
      `Job created: ${job.id}`,
      `status: ${job.status}`,
      admin.paused ? "Execution is paused (/panic on). Job will wait." : undefined,
      "Running..."
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"));
  }

  if (job.status !== "needs_approval") {
    void trackJob(job.chatId, job.threadId, job.id);
  }
}

async function handleStatus(ctx: any, fromId: string, chatId: string, jobId: string): Promise<void> {
  const job = await orchestrator.getJob(jobId);
  if (!canViewJob(fromId, chatId, job)) {
    await ctx.reply("You are not allowed to view that job.");
    return;
  }

  await ctx.reply(renderJobStatus(job));
}

async function handleApproveJob(ctx: any, fromId: string, jobId: string): Promise<void> {
  if (approveOwnerOnly && !pairings.isOwner(fromId)) {
    await ctx.reply("Only owners can approve jobs.");
    return;
  }

  const jobBefore = await orchestrator.getJob(jobId);
  if (!pairings.isOwner(fromId) && !canViewJob(fromId, String(ctx.chat.id), jobBefore)) {
    await ctx.reply("You are not allowed to approve that job.");
    return;
  }

  const job = await orchestrator.approveJob(jobId);
  await ctx.reply(`Job ${job.id} status: ${job.status}`);

  if (!isTerminalStatus(job.status)) {
    void trackJob(job.chatId, job.threadId, job.id);
  }
}

async function handleAbortJob(ctx: any, fromId: string, chatId: string, jobId: string): Promise<void> {
  const jobBefore = await orchestrator.getJob(jobId);
  const owner = pairings.isOwner(fromId);
  const requesterAbortAllowed =
    allowRequesterAbort && jobBefore.requesterId === fromId && jobBefore.chatId === chatId;

  if (!owner && !requesterAbortAllowed) {
    await ctx.reply("You are not allowed to abort that job.");
    return;
  }

  const job = await orchestrator.abortJob(jobId);
  await ctx.reply(`Abort requested for ${job.id}. Current status: ${job.status}`);
}

async function enforcePromptPolicies(ctx: any, userId: string, prompt: string): Promise<boolean> {
  if (prompt.length > promptMaxChars) {
    await ctx.reply(`Prompt too long (${prompt.length}). Max allowed is ${promptMaxChars} characters.`);
    return false;
  }

  const limit = rateLimiter.consume(userId);
  if (!limit.allowed) {
    const waitSecs = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    await ctx.reply(`Rate limit hit. Try again in about ${waitSecs}s.`);
    return false;
  }

  return true;
}

function canViewJob(userId: string, chatId: string, job: Job): boolean {
  if (pairings.isOwner(userId)) {
    return true;
  }
  return job.requesterId === userId && job.chatId === chatId;
}

async function trackJob(chatId: string, threadId: string | undefined, jobId: string): Promise<void> {
  if (activeTrackers.has(jobId)) {
    return;
  }

  activeTrackers.add(jobId);
  let cursor = 0;
  let runningNotified = false;

  try {
    for (;;) {
      const events = await orchestrator.getEvents(jobId, cursor);
      cursor = events.nextCursor;

      for (const event of events.events) {
        if (!onlyAgentOutput && event.type === "job_started" && !runningNotified) {
          runningNotified = true;
          await sendThreadMessage(chatId, threadId, `Job ${jobId} started in VM.`);
        }

        if (!onlyAgentOutput && notifyToolEvents && event.type === "tool_start" && event.data?.toolName) {
          await sendThreadMessage(chatId, threadId, `Tool: ${String(event.data.toolName)} started.`);
        }
      }

      const job = await orchestrator.getJob(jobId);
      if (isTerminalStatus(job.status)) {
        await sendTerminalJobMessage(chatId, threadId, job);
        break;
      }

      await sleep(jobPollMs);
    }
  } catch (error) {
    await sendThreadMessage(chatId, threadId, `Tracking failed for ${jobId}: ${formatError(error)}`);
  } finally {
    activeTrackers.delete(jobId);
  }
}

async function sendTerminalJobMessage(chatId: string, threadId: string | undefined, job: Job): Promise<void> {
  if (job.status === "completed") {
    const result = job.resultText?.trim() || "(No output)";
    const chunks = splitMessage(result, agentMarkdownV2 ? 2800 : 3500);

    if (!onlyAgentOutput) {
      await sendThreadMessage(chatId, threadId, `Job ${job.id} completed.`);
    }
    for (const chunk of chunks) {
      await sendThreadMessage(chatId, threadId, chunk, agentMarkdownV2 ? "markdownv2" : "plain");
    }
    return;
  }

  if (job.status === "aborted") {
    await sendThreadMessage(chatId, threadId, onlyAgentOutput ? "Execution aborted." : `Job ${job.id} aborted.`);
    return;
  }

  if (job.status === "failed") {
    await sendThreadMessage(chatId, threadId, `Job ${job.id} failed:\n${job.error ?? "Unknown error"}`);
    return;
  }
}

type TelegramMessageFormat = "plain" | "markdownv2";

async function sendThreadMessage(
  chatId: string,
  threadId: string | undefined,
  text: string,
  format: TelegramMessageFormat = "plain"
): Promise<void> {
  const chat = Number(chatId);
  if (Number.isNaN(chat)) {
    throw new Error(`invalid chat id: ${chatId}`);
  }

  const thread = threadId ? Number(threadId) : undefined;
  const messageThreadId = threadId && !Number.isNaN(thread) ? thread : undefined;

  if (format === "markdownv2") {
    try {
      await bot.api.sendMessage(chat, toTelegramMarkdownV2(text), {
        message_thread_id: messageThreadId,
        parse_mode: "MarkdownV2"
      });
      return;
    } catch (error) {
      if (!isTelegramEntityParseError(error)) {
        throw error;
      }
      console.warn(`[gateway] MarkdownV2 send failed, falling back to plain text: ${formatError(error)}`);
    }
  }

  await bot.api.sendMessage(chat, text, {
    message_thread_id: messageThreadId
  });
}

function renderJobStatus(job: Job): string {
  return [
    `job: ${job.id}`,
    `status: ${job.status}`,
    `kind: ${job.kind}`,
    `requester: ${job.requesterId}`,
    `chat: ${job.chatId}`,
    `created: ${job.createdAt}`,
    `updated: ${job.updatedAt}`,
    job.workerId ? `worker: ${job.workerId}` : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderAdminState(admin: { paused: boolean; pauseReason?: string; updatedAt: string }): string {
  return [
    `paused: ${admin.paused}`,
    admin.pauseReason ? `reason: ${admin.pauseReason}` : undefined,
    `updated: ${admin.updatedAt}`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionSummary(
  chatId: string,
  threadId: string | undefined,
  sessionKey: string,
  generation: number,
  lastResetAt: string
): string {
  return [
    `chat: ${chatId}`,
    threadId ? `thread: ${threadId}` : undefined,
    `session: ${sessionKey}`,
    `session_generation: ${generation}`,
    `session_reset_at: ${lastResetAt}`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function helpText(): string {
  return [
    "Commands:",
    "/whoami - show your Telegram user id",
    "/task <request> - create a normal task",
    "/run <command> - create a command job (approval required)",
    "/approve <jobId> - approve a pending /run job",
    "/abort <jobId> - request abort",
    "/status - show gateway/session status for this chat",
    "/status <jobId> - fetch status for a specific job",
    "/context - show current chat session context key",
    "/new [prompt] - reset session context; optional prompt runs in new session",
    "/reset [prompt] - same as /new",
    "/panic [status|on|off] - pause/resume execution (owner)",
    "/pairings - list pending pairings (owner)",
    "/approvepair <code> - approve pairing (owner)",
    "",
    "Plain text is treated like /task"
  ].join("\n");
}

function splitMessage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const slice = text.slice(offset, offset + maxChars);
    chunks.push(slice);
    offset += maxChars;
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function runProactiveDeliveryLoop(): Promise<void> {
  for (;;) {
    try {
      const jobs = await orchestrator.listPendingProactiveDeliveries(20);
      if (jobs.length === 0) {
        await sleep(proactiveDeliveryPollMs);
        continue;
      }

      for (const job of jobs) {
        try {
          const receipt = await deliverProactiveJob(job);
          await orchestrator.ackProactiveDelivery(job.id, receipt);
        } catch (error) {
          console.warn(`[gateway] proactive delivery failed job=${job.id}: ${formatError(error)}`);
        }
      }
    } catch (error) {
      console.warn(`[gateway] proactive delivery loop error: ${formatError(error)}`);
      await sleep(proactiveDeliveryPollMs);
    }
  }
}

async function deliverProactiveJob(job: Job): Promise<string> {
  const mode = job.metadata?.proactiveDeliveryMode ?? "announce";
  if (mode === "none") {
    return `none:${new Date().toISOString()}`;
  }

  if (mode === "announce") {
    await sendTerminalJobMessage(job.chatId, job.threadId, job);
    return `announce:${new Date().toISOString()}`;
  }

  if (mode === "webhook") {
    const url = job.metadata?.proactiveDeliveryWebhookUrl;
    if (!url) {
      throw new Error("missing proactiveDeliveryWebhookUrl");
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        status: job.status,
        resultText: job.resultText ?? "",
        error: job.error ?? "",
        finishedAt: job.finishedAt ?? null,
        trigger: {
          kind: job.metadata?.proactiveTriggerKind ?? null,
          id: job.metadata?.proactiveTriggerId ?? null
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`webhook delivery failed (${response.status}): ${text}`);
    }

    return `webhook:${new Date().toISOString()}`;
  }

  throw new Error(`unsupported proactive delivery mode '${mode}'`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isTelegramEntityParseError(error: unknown): boolean {
  const text = formatError(error).toLowerCase();
  return text.includes("can't parse entities") || text.includes("parse entities");
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function requireSecret(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required secret ${name}`);
  }
  if (value.length < 16) {
    throw new Error(`${name} must be at least 16 characters`);
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
