import type { Job } from "@pi-self/contracts";
import { isTerminalStatus } from "@pi-self/contracts";
import { formatError } from "./gateway-utils.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import type { PairingStore } from "./pairing-store.js";
import type { SessionStore } from "./session-store.js";
import type { TelegramMessageFormat } from "./job-tracker.js";

export interface CommandRouterConfig {
  pairings: PairingStore;
  sessions: SessionStore;
  orchestrator: OrchestratorClient;
  trackJob(chatId: string, threadId: string | undefined, jobId: string): Promise<void>;
  sendThreadMessage(chatId: string, threadId: string | undefined, text: string, format?: TelegramMessageFormat): Promise<void>;
  activeTrackers: Set<string>;
  rateLimitPerMinute: number;
  runOwnerOnly: boolean;
  approveOwnerOnly: boolean;
  allowRequesterAbort: boolean;
  promptMaxChars: number;
  onlyAgentOutput: boolean;
}

export interface CommandRouter {
  handleTextMessage(ctx: any): Promise<void>;
  handleUnpairedMessage(ctx: any, fromId: string): Promise<void>;
  enforcePromptPolicies(ctx: any, userId: string, prompt: string): Promise<boolean>;
  submitJob(ctx: any, prompt: string, kind: "task" | "run", requiresApproval: boolean, metadata?: Record<string, string>): Promise<void>;
}

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

    // Evict stale bucket when the window has fully expired to prevent unbounded Map growth.
    if (recent.length === 0 && current.length > 0) {
      this.buckets.delete(key);
    }

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

export function createCommandRouter(cfg: CommandRouterConfig): CommandRouter {
  const {
    pairings, sessions, orchestrator, trackJob, sendThreadMessage, activeTrackers,
    rateLimitPerMinute, runOwnerOnly, approveOwnerOnly, allowRequesterAbort, promptMaxChars, onlyAgentOutput
  } = cfg;

  const rateLimiter = new SlidingWindowRateLimiter(rateLimitPerMinute, 60_000);

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

  async function submitJob(
    ctx: any,
    prompt: string,
    kind: "task" | "run",
    requiresApproval: boolean,
    metadata?: Record<string, string>
  ): Promise<void> {
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
      metadata: mergeJobMetadata(kind === "run" ? { command: prompt } : undefined, metadata)
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

  function canViewJob(userId: string, chatId: string, job: Job): boolean {
    if (pairings.isOwner(userId)) {
      return true;
    }
    return job.requesterId === userId && job.chatId === chatId;
  }

  async function handleTextMessage(ctx: any): Promise<void> {
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
  }

  return { handleTextMessage, handleUnpairedMessage, enforcePromptPolicies, submitJob };
}

function mergeJobMetadata(
  ...entries: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (value.length > 0) {
        merged[key] = value;
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
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
    "Plain text is treated like /task",
    "Voice notes, audio files, and photos are treated like /task when media understanding is enabled"
  ].join("\n");
}

