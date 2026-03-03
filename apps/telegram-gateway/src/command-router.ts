import type { Channel, Job } from "@pi-self/contracts";
import { isTerminalStatus } from "@pi-self/contracts";
import { compactLines, formatError, parseSender } from "./gateway-utils.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import type { PairingStore } from "./pairing-store.js";
import type { SessionStore } from "./session-store.js";
import type { TelegramMessageFormat } from "./job-tracker.js";

export interface CommandRouterConfig {
  channel: Channel;
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
    channel, pairings, sessions, orchestrator, trackJob, sendThreadMessage, activeTrackers,
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
    const fromId = parseSender(ctx) ?? "";
    const chatId = String(ctx.chat.id);
    const threadId = ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined;
    const session = sessions.touchSession(chatId, threadId);
    const sessionKey = session.sessionKey;

    const admin = await orchestrator.getAdminState();
    const job = await orchestrator.createJob({
      kind,
      prompt,
      channel,
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
      await sendThreadMessage(chatId, threadId, compactLines([
        `Job created: ${job.id}`,
        `status: ${job.status}`,
        admin.paused ? "Execution is paused (/panic on). Job will wait." : undefined,
        "Running..."
      ]));
    }

    if (job.status !== "needs_approval") {
      void trackJob(job.chatId, job.threadId, job.id);
    }
  }

  async function handlePanic(ctx: any, rawArg: string): Promise<void> {
    const arg = rawArg.toLowerCase() || "status";

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

  // ── Command dispatch table ───────────────────────────────────────────
  // Each entry handles a bot command. `args` is the trimmed text after the
  // command prefix (empty string for exact-match invocations like "/context").
  type CmdHandler = (args: string, ctx: any, fromId: string, chatId: string, threadId: string | undefined) => Promise<void>;
  interface CmdEntry { cmd: string; ownerOnly?: boolean; handler: CmdHandler }

  const commandTable: CmdEntry[] = [
    { cmd: "/start",  handler: async (_, ctx) => ctx.reply(helpText()) },
    { cmd: "/help",   handler: async (_, ctx) => ctx.reply(helpText()) },
    { cmd: "/pairings", ownerOnly: true, handler: async (_, ctx) => {
      const pending = pairings.listPending();
      if (pending.length === 0) { await ctx.reply("No pending pairing requests."); return; }
      const summary = pending.map((e) => `code=${e.code} user=${e.userId} created=${e.createdAt}`).join("\n");
      await ctx.reply(`Pending pairings:\n${summary}`);
    }},
    { cmd: "/approvepair", ownerOnly: true, handler: async (args, ctx) => {
      const code = args.toUpperCase();
      if (!code) { await ctx.reply("Usage: /approvepair <CODE>"); return; }
      const approved = pairings.approveCode(code);
      if (!approved) { await ctx.reply(`No pending pairing found for code ${code}.`); return; }
      await ctx.reply(`Approved user ${approved.userId}`);
    }},
    { cmd: "/panic", ownerOnly: true, handler: async (args, ctx) => handlePanic(ctx, args) },
    { cmd: "/status", handler: async (args, ctx, fromId, chatId, threadId) => {
      if (!args) { await handleStatusSummary(ctx, chatId, threadId); return; }
      await handleStatus(ctx, fromId, chatId, args);
    }},
    { cmd: "/approve", handler: async (args, ctx, fromId) => {
      if (!args) { await ctx.reply("Usage: /approve <jobId>"); return; }
      await handleApproveJob(ctx, fromId, args);
    }},
    { cmd: "/abort", handler: async (args, ctx, fromId, chatId) => {
      if (!args) { await ctx.reply("Usage: /abort <jobId>"); return; }
      await handleAbortJob(ctx, fromId, chatId, args);
    }},
    { cmd: "/context", handler: async (_, ctx, _fromId, chatId, threadId) => handleContext(ctx, chatId, threadId) },
    { cmd: "/new",   handler: async (args, ctx, fromId, chatId, threadId) => handleResetSession(ctx, fromId, chatId, threadId, args) },
    { cmd: "/reset", handler: async (args, ctx, fromId, chatId, threadId) => handleResetSession(ctx, fromId, chatId, threadId, args) },
    { cmd: "/task", handler: async (args, ctx, fromId) => {
      if (!args) { await ctx.reply("Usage: /task <request>"); return; }
      if (!(await enforcePromptPolicies(ctx, fromId, args))) return;
      await submitJob(ctx, args, "task", false);
    }},
    { cmd: "/run", handler: async (args, ctx, fromId) => {
      if (runOwnerOnly && !pairings.isOwner(fromId)) { await ctx.reply("/run is owner-only in this deployment."); return; }
      if (!args) { await ctx.reply("Usage: /run <command>"); return; }
      if (!(await enforcePromptPolicies(ctx, fromId, args))) return;
      await submitJob(ctx, args, "run", true);
    }},
  ];

  async function handleTextMessage(ctx: any): Promise<void> {
    try {
      const text = ctx.message.text.trim();
      const fromId = parseSender(ctx);
      const chatId = String(ctx.chat.id);
      const threadId = ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined;

      if (!fromId) return;

      // /whoami works without pairing (users need it to request pairing)
      if (text === "/whoami") {
        await ctx.reply(`telegram_user_id=${fromId}`);
        return;
      }

      if (!pairings.isAllowed(fromId)) {
        await handleUnpairedMessage(ctx, fromId);
        return;
      }

      // Dispatch: find matching command by exact match or prefix
      for (const entry of commandTable) {
        const args = matchArgs(text, entry.cmd);
        if (args === null) continue;
        if (entry.ownerOnly && !pairings.isOwner(fromId)) {
          await ctx.reply("Owner-only command.");
          return;
        }
        await entry.handler(args, ctx, fromId, chatId, threadId);
        return;
      }

      if (text.startsWith("/")) {
        await ctx.reply(helpText());
        return;
      }

      // Plain text → task
      if (!(await enforcePromptPolicies(ctx, fromId, text))) return;
      await submitJob(ctx, text, "task", false);
    } catch (error) {
      await ctx.reply(`Request failed: ${formatError(error)}`);
    }
  }

  return { handleTextMessage, handleUnpairedMessage, enforcePromptPolicies, submitJob };
}

/** Returns the trimmed args after a command prefix, or null if not matched. */
function matchArgs(text: string, cmd: string): string | null {
  if (text === cmd) return "";
  if (text.startsWith(cmd + " ")) return text.slice(cmd.length).trim();
  return null;
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
  return compactLines([
    `job: ${job.id}`,
    `status: ${job.status}`,
    `kind: ${job.kind}`,
    `requester: ${job.requesterId}`,
    `chat: ${job.chatId}`,
    `created: ${job.createdAt}`,
    `updated: ${job.updatedAt}`,
    job.workerId ? `worker: ${job.workerId}` : undefined
  ]);
}

function renderAdminState(admin: { paused: boolean; pauseReason?: string; updatedAt: string }): string {
  return compactLines([
    `paused: ${admin.paused}`,
    admin.pauseReason ? `reason: ${admin.pauseReason}` : undefined,
    `updated: ${admin.updatedAt}`
  ]);
}

function renderSessionSummary(
  chatId: string,
  threadId: string | undefined,
  sessionKey: string,
  generation: number,
  lastResetAt: string
): string {
  return compactLines([
    `chat: ${chatId}`,
    threadId ? `thread: ${threadId}` : undefined,
    `session: ${sessionKey}`,
    `session_generation: ${generation}`,
    `session_reset_at: ${lastResetAt}`
  ]);
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

