import {
  ProactiveConfigSummarySchema,
  ProactiveCronRuleSchema,
  ProactiveHeartbeatRuleSchema,
  ProactiveTargetSchema,
  type Job,
  type JobCreateRequest,
  type JobKind,
  type ProactiveConfigSummary,
  type ProactiveCronRule,
  type ProactiveHeartbeatRule
} from "@pi-self/contracts";
import { z } from "zod";
import type { OrchestratorStore } from "./store.js";

const WebhookRuleSchema = z.object({
  id: z.string().min(1).max(120),
  secret: z.string().min(16).max(200),
  prompt: z.string().min(1).max(18_000),
  includePayloadInPrompt: z.boolean().default(true),
  target: ProactiveTargetSchema
});

const ProactiveConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tickMs: z.number().int().min(500).max(60_000).default(5_000),
  heartbeatRules: z.array(ProactiveHeartbeatRuleSchema).default([]),
  cronRules: z.array(ProactiveCronRuleSchema).default([]),
  webhooks: z.array(WebhookRuleSchema).default([]),
  webhookPayloadMaxChars: z.number().int().min(256).max(200_000).default(8_000)
});

type ProactiveConfig = z.infer<typeof ProactiveConfigSchema>;
type ProactiveTarget = ProactiveHeartbeatRule["target"];
type ProactiveDelivery = ProactiveCronRule["delivery"];
type WebhookRule = z.infer<typeof WebhookRuleSchema>;

type TriggerKind = "heartbeat" | "cron" | "webhook";
const MAX_JOB_PROMPT_CHARS = 20_000;
const RETRY_BACKOFF_SECONDS = [30, 60, 300, 900, 3600] as const;

interface RuntimeStats {
  lastHeartbeatTickAt?: string;
  lastCronTickAt?: string;
  lastWebhookAt?: string;
  lastError?: string;
}

export interface ProactiveRuntimeState {
  enabled: boolean;
  running: boolean;
  tickMs: number;
  heartbeatRules: number;
  cronRules: number;
  webhookRules: number;
  stats: RuntimeStats;
}

export interface WebhookTriggerResult {
  status: "enqueued" | "duplicate_active_job" | "backoff_blocked" | "unauthorized" | "not_found";
  jobId?: string;
}

export interface TriggerRuleResult {
  status: "enqueued" | "duplicate_active_job" | "backoff_blocked" | "not_found";
  jobId?: string;
}

interface ProactiveRuntimeOptions {
  onConfigChange?: (config: ProactiveConfig) => void;
}

export class ProactiveRuntime {
  private readonly config: ProactiveConfig;
  private readonly webhookById: Map<string, WebhookRule>;
  private readonly nextHeartbeatAtMs = new Map<string, number>();
  private readonly lastCronMinuteKey = new Map<string, string>();
  private readonly nextEveryAtMs = new Map<string, number>();
  private readonly pendingMainWakeCronRules = new Set<string>();
  private readonly failureStreakByTrigger = new Map<string, number>();
  private readonly blockedUntilByTriggerMs = new Map<string, number>();
  private readonly lastTerminalSeenByTrigger = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly stats: RuntimeStats = {};
  private readonly onConfigChange?: (config: ProactiveConfig) => void;

  constructor(
    private readonly store: OrchestratorStore,
    rawConfig: unknown,
    loggerOrOptions: Pick<Console, "log" | "error"> | ProactiveRuntimeOptions = console,
    loggerMaybe: Pick<Console, "log" | "error"> = console
  ) {
    const resolved =
      "onConfigChange" in loggerOrOptions
        ? { options: loggerOrOptions as ProactiveRuntimeOptions, logger: loggerMaybe }
        : { options: {}, logger: loggerOrOptions as Pick<Console, "log" | "error"> };
    this.logger = resolved.logger;
    this.onConfigChange = resolved.options.onConfigChange;
    this.config = parseConfig(rawConfig);
    this.webhookById = new Map(this.config.webhooks.map((item) => [item.id, item]));

    const now = Date.now();
    for (const rule of this.config.heartbeatRules) {
      this.nextHeartbeatAtMs.set(rule.id, now + rule.everySeconds * 1000);
    }
    for (const rule of this.config.cronRules) {
      if (rule.everySeconds) {
        this.nextEveryAtMs.set(rule.id, now + rule.everySeconds * 1000);
      }
    }
  }

  private readonly logger: Pick<Console, "log" | "error">;

  start(): void {
    if (!this.config.enabled || this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.tickMs);

    this.logger.log(
      `[orchestrator] proactive runtime enabled (heartbeat=${this.config.heartbeatRules.length}, cron=${this.config.cronRules.length}, webhooks=${this.config.webhooks.length}, tickMs=${this.config.tickMs})`
    );
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  getState(): ProactiveRuntimeState {
    return {
      enabled: this.config.enabled,
      running: Boolean(this.timer),
      tickMs: this.config.tickMs,
      heartbeatRules: this.config.heartbeatRules.length,
      cronRules: this.config.cronRules.length,
      webhookRules: this.config.webhooks.length,
      stats: { ...this.stats }
    };
  }

  getConfigSummary(): ProactiveConfigSummary {
    return ProactiveConfigSummarySchema.parse({
      enabled: this.config.enabled,
      tickMs: this.config.tickMs,
      heartbeatRules: this.config.heartbeatRules,
      cronRules: this.config.cronRules,
      webhookRules: this.config.webhooks.map((item) => ({ id: item.id }))
    });
  }

  getConfigForPersistence(): unknown {
    return JSON.parse(JSON.stringify(this.config));
  }

  upsertHeartbeatRule(rule: ProactiveHeartbeatRule): ProactiveHeartbeatRule {
    const parsed = ProactiveHeartbeatRuleSchema.parse(rule);
    const updated = replaceById(this.config.heartbeatRules, parsed);
    this.config.heartbeatRules = updated;
    this.nextHeartbeatAtMs.set(parsed.id, Date.now() + parsed.everySeconds * 1000);
    this.persistConfig();
    return parsed;
  }

  deleteHeartbeatRule(id: string): boolean {
    const before = this.config.heartbeatRules.length;
    this.config.heartbeatRules = this.config.heartbeatRules.filter((item) => item.id !== id);
    this.nextHeartbeatAtMs.delete(id);
    const removed = this.config.heartbeatRules.length !== before;
    if (removed) {
      this.persistConfig();
    }
    return removed;
  }

  triggerHeartbeatNow(id: string): TriggerRuleResult {
    const rule = this.config.heartbeatRules.find((item) => item.id === id);
    if (!rule) {
      return { status: "not_found" };
    }

    const result = this.enqueue("heartbeat", rule.id, rule.prompt, rule.target, {
      proactiveManualTrigger: "true"
    }, rule.delivery);
    if (result.status !== "enqueued") {
      return { status: result.status };
    }

    return { status: "enqueued", jobId: result.job.id };
  }

  upsertCronRule(rule: ProactiveCronRule): ProactiveCronRule {
    const parsed = ProactiveCronRuleSchema.parse(rule);
    if (parsed.cron) {
      assertCronExpression(parsed.cron);
    }
    if (parsed.timezone) {
      assertTimezone(parsed.timezone);
    }
    if (parsed.everySeconds) {
      this.nextEveryAtMs.set(parsed.id, Date.now() + parsed.everySeconds * 1000);
    } else {
      this.nextEveryAtMs.delete(parsed.id);
    }
    this.config.cronRules = replaceById(this.config.cronRules, parsed);
    this.persistConfig();
    return parsed;
  }

  deleteCronRule(id: string): boolean {
    const before = this.config.cronRules.length;
    this.config.cronRules = this.config.cronRules.filter((item) => item.id !== id);
    this.lastCronMinuteKey.delete(id);
    this.nextEveryAtMs.delete(id);
    const removed = this.config.cronRules.length !== before;
    if (removed) {
      this.persistConfig();
    }
    return removed;
  }

  triggerCronNow(id: string): TriggerRuleResult {
    const rule = this.config.cronRules.find((item) => item.id === id);
    if (!rule) {
      return { status: "not_found" };
    }

    const target = this.resolveTarget(rule, rule.target);
    const result = this.enqueue("cron", rule.id, rule.prompt, target, {
      proactiveManualTrigger: "true"
    }, rule.delivery);
    if (result.status !== "enqueued") {
      return { status: result.status };
    }

    return { status: "enqueued", jobId: result.job.id };
  }

  triggerWebhook(webhookId: string, providedSecret: string | undefined, payload: unknown): WebhookTriggerResult {
    const rule = this.webhookById.get(webhookId);
    this.stats.lastWebhookAt = new Date().toISOString();

    if (!rule) {
      return { status: "not_found" };
    }

    if (!providedSecret || providedSecret !== rule.secret) {
      return { status: "unauthorized" };
    }

    const prompt = rule.includePayloadInPrompt
      ? buildWebhookPrompt(rule.prompt, payload, this.config.webhookPayloadMaxChars)
      : rule.prompt;

    const metadata: Record<string, string> = {
      proactiveWebhookId: webhookId,
      proactivePayloadHash: simplePayloadHash(payload)
    };

    const result = this.enqueue("webhook", rule.id, prompt, rule.target, metadata);
    if (result.status !== "enqueued") {
      return { status: result.status };
    }

    return {
      status: "enqueued",
      jobId: result.job.id
    };
  }

  private async tick(): Promise<void> {
    try {
      const now = new Date();
      const nowMs = now.getTime();
      let heartbeatFired = false;

      this.stats.lastHeartbeatTickAt = now.toISOString();
      for (const rule of this.config.heartbeatRules) {
        const dueAt = this.nextHeartbeatAtMs.get(rule.id) ?? nowMs;
        if (nowMs < dueAt) {
          continue;
        }

        const result = this.enqueue("heartbeat", rule.id, rule.prompt, rule.target, undefined, rule.delivery);
        if (result.status === "enqueued") {
          heartbeatFired = true;
        }
        this.nextHeartbeatAtMs.set(rule.id, nowMs + rule.everySeconds * 1000);
      }

      if (heartbeatFired && this.pendingMainWakeCronRules.size > 0) {
        const pending = new Set(this.pendingMainWakeCronRules);
        for (const rule of this.config.cronRules) {
          if (!pending.has(rule.id)) {
            continue;
          }
          const target = this.resolveTarget(rule, rule.target);
          const result = this.enqueue(
            "cron",
            rule.id,
            rule.prompt,
            target,
            { proactiveWakeMode: "next-heartbeat" },
            rule.delivery
          );
          if (result.status === "enqueued" || result.status === "duplicate_active_job") {
            this.pendingMainWakeCronRules.delete(rule.id);
          }
        }
      }

      this.stats.lastCronTickAt = now.toISOString();
      const minuteKey = toMinuteKey(now);
      const nextCronRules: ProactiveCronRule[] = [];
      let cronRulesChanged = false;
      for (const rule of this.config.cronRules) {
        if (rule.cron) {
          if (!matchesCronExpression(rule.cron, now, rule.timezone)) {
            nextCronRules.push(rule);
            continue;
          }

          if (this.lastCronMinuteKey.get(rule.id) === minuteKey) {
            nextCronRules.push(rule);
            continue;
          }

          if (rule.sessionTarget === "main" && rule.wakeMode === "next-heartbeat") {
            this.pendingMainWakeCronRules.add(rule.id);
            this.lastCronMinuteKey.set(rule.id, minuteKey);
            nextCronRules.push(rule);
            continue;
          }

          const target = this.resolveTarget(rule, rule.target);
          this.enqueue("cron", rule.id, rule.prompt, target, undefined, rule.delivery);
          this.lastCronMinuteKey.set(rule.id, minuteKey);
          nextCronRules.push(rule);
          continue;
        }

        if (rule.everySeconds) {
          const dueAt = this.nextEveryAtMs.get(rule.id) ?? nowMs;
          if (nowMs < dueAt) {
            nextCronRules.push(rule);
            continue;
          }
          if (rule.sessionTarget === "main" && rule.wakeMode === "next-heartbeat") {
            this.pendingMainWakeCronRules.add(rule.id);
            this.nextEveryAtMs.set(rule.id, nowMs + rule.everySeconds * 1000);
            nextCronRules.push(rule);
            continue;
          }
          const target = this.resolveTarget(rule, rule.target);
          this.enqueue("cron", rule.id, rule.prompt, target, undefined, rule.delivery);
          this.nextEveryAtMs.set(rule.id, nowMs + rule.everySeconds * 1000);
          nextCronRules.push(rule);
          continue;
        }

        if (rule.at) {
          const dueAt = Date.parse(rule.at);
          if (!Number.isFinite(dueAt) || nowMs < dueAt) {
            nextCronRules.push(rule);
            continue;
          }
          if (rule.sessionTarget === "main" && rule.wakeMode === "next-heartbeat") {
            this.pendingMainWakeCronRules.add(rule.id);
            nextCronRules.push(rule);
            continue;
          }

          const target = this.resolveTarget(rule, rule.target);
          const result = this.enqueue("cron", rule.id, rule.prompt, target, undefined, rule.delivery);
          if (result.status !== "enqueued") {
            nextCronRules.push(rule);
            continue;
          }
          this.lastCronMinuteKey.delete(rule.id);
          this.nextEveryAtMs.delete(rule.id);
          cronRulesChanged = true;
          continue;
        }

        nextCronRules.push(rule);
      }

      if (cronRulesChanged) {
        this.config.cronRules = nextCronRules;
        this.persistConfig();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stats.lastError = `${new Date().toISOString()} ${message}`;
      this.logger.error(`[orchestrator] proactive tick error: ${message}`);
    }
  }

  private enqueue(
    kind: TriggerKind,
    triggerId: string,
    prompt: string,
    target: ProactiveTarget,
    metadata?: Record<string, string>,
    delivery?: ProactiveDelivery
  ): { status: "enqueued"; job: Job } | { status: "duplicate_active_job" | "backoff_blocked" } {
    const triggerKey = `${kind}:${triggerId}`;
    if (kind !== "webhook") {
      this.refreshBackoffState(triggerKey);
      const blockedUntil = this.blockedUntilByTriggerMs.get(triggerKey);
      if (blockedUntil && Date.now() < blockedUntil) {
        return { status: "backoff_blocked" };
      }
    }

    if (this.store.hasActiveJobByMetadata("proactiveTriggerKey", triggerKey)) {
      return { status: "duplicate_active_job" };
    }

    const now = new Date().toISOString();
    const safePrompt =
      prompt.length <= MAX_JOB_PROMPT_CHARS
        ? prompt
        : `${prompt.slice(0, MAX_JOB_PROMPT_CHARS - 15)}...[truncated]`;
    const request: JobCreateRequest = {
      kind: target.kind as JobKind,
      prompt: safePrompt,
      channel: "telegram",
      chatId: target.chatId,
      threadId: target.threadId,
      requesterId: target.requesterId,
      sessionKey: target.sessionKey,
      requiresApproval: target.requiresApproval,
      metadata: {
        ...(target.metadata ?? {}),
        ...(metadata ?? {}),
        proactiveTriggerKind: kind,
        proactiveTriggerId: triggerId,
        proactiveTriggerKey: triggerKey,
        proactiveTriggeredAt: now,
        proactivePromptTruncated: String(prompt.length > MAX_JOB_PROMPT_CHARS),
        proactiveDeliveryMode: delivery?.mode ?? "announce",
        ...(delivery?.webhookUrl ? { proactiveDeliveryWebhookUrl: delivery.webhookUrl } : {})
      }
    };

    const job = this.store.createJob(request);
    this.logger.log(`[orchestrator] proactive enqueue kind=${kind} trigger=${triggerId} job=${job.id}`);
    return { status: "enqueued", job };
  }

  private resolveTarget(rule: ProactiveCronRule, target: ProactiveTarget): ProactiveTarget {
    if (rule.sessionTarget !== "isolated") {
      return target;
    }
    return { ...target, sessionKey: `cron:${rule.id}` };
  }

  private refreshBackoffState(triggerKey: string): void {
    const latest = this.store.getLatestTerminalJobByMetadata("proactiveTriggerKey", triggerKey);
    if (!latest) {
      return;
    }

    const marker = `${latest.id}:${latest.updatedAt}:${latest.status}`;
    if (this.lastTerminalSeenByTrigger.get(triggerKey) === marker) {
      return;
    }
    this.lastTerminalSeenByTrigger.set(triggerKey, marker);

    if (latest.status === "failed") {
      const streak = (this.failureStreakByTrigger.get(triggerKey) ?? 0) + 1;
      this.failureStreakByTrigger.set(triggerKey, streak);
      const idx = Math.min(streak - 1, RETRY_BACKOFF_SECONDS.length - 1);
      const delaySeconds = RETRY_BACKOFF_SECONDS[idx] ?? RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1];
      const baseMs = Number.isFinite(Date.parse(latest.updatedAt)) ? Date.parse(latest.updatedAt) : Date.now();
      this.blockedUntilByTriggerMs.set(triggerKey, baseMs + delaySeconds * 1000);
      return;
    }

    this.failureStreakByTrigger.delete(triggerKey);
    this.blockedUntilByTriggerMs.delete(triggerKey);
  }

  private persistConfig(): void {
    this.onConfigChange?.(this.config);
  }
}

function parseConfig(rawConfig: unknown): ProactiveConfig {
  const parsed = ProactiveConfigSchema.parse(rawConfig ?? {});
  const seen = new Set<string>();

  for (const rule of parsed.heartbeatRules) {
    ensureUniqueId(`heartbeat:${rule.id}`, seen);
  }

  for (const rule of parsed.cronRules) {
    ensureUniqueId(`cron:${rule.id}`, seen);
    if (rule.cron) {
      assertCronExpression(rule.cron);
    }
    if (rule.timezone) {
      assertTimezone(rule.timezone);
    }
    if (rule.at && !Number.isFinite(Date.parse(rule.at))) {
      throw new Error(`Invalid at schedule timestamp '${rule.at}' for cron rule '${rule.id}'`);
    }
  }

  for (const rule of parsed.webhooks) {
    ensureUniqueId(`webhook:${rule.id}`, seen);
  }

  return parsed;
}

function ensureUniqueId(key: string, seen: Set<string>): void {
  if (seen.has(key)) {
    throw new Error(`Duplicate proactive rule id: ${key}`);
  }

  seen.add(key);
}

function replaceById<T extends { id: string }>(items: T[], next: T): T[] {
  const existing = items.findIndex((item) => item.id === next.id);
  if (existing === -1) {
    return [...items, next];
  }

  return items.map((item, index) => (index === existing ? next : item));
}

function buildWebhookPrompt(basePrompt: string, payload: unknown, maxChars: number): string {
  const serialized = safeStringify(payload);
  const sliced = serialized.length <= maxChars ? serialized : `${serialized.slice(0, maxChars)}\n...[truncated]`;
  return `${basePrompt}\n\nWebhook payload:\n${sliced}`;
}

function safeStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? {}, null, 2);
  } catch {
    return "[unserializable payload]";
  }
}

function simplePayloadHash(payload: unknown): string {
  const value = safeStringify(payload);
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function toMinuteKey(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function assertCronExpression(expr: string): void {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression '${expr}'. Expected 5 fields.`);
  }

  parseCronField(fields[0], 0, 59, "minute");
  parseCronField(fields[1], 0, 23, "hour");
  parseCronField(fields[2], 1, 31, "day_of_month");
  parseCronField(fields[3], 1, 12, "month");
  parseCronField(fields[4], 0, 7, "day_of_week");
}

function assertTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone '${timezone}'`);
  }
}

function matchesCronExpression(expr: string, now: Date, timezone?: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }

  const parts = timezone ? toTimeParts(now, timezone) : toLocalTimeParts(now);
  const minute = parts.minute;
  const hour = parts.hour;
  const dayOfMonth = parts.dayOfMonth;
  const month = parts.month;
  const dayOfWeek = parts.dayOfWeek;

  const minuteMatch = matchCronField(fields[0], minute, 0, 59);
  const hourMatch = matchCronField(fields[1], hour, 0, 23);
  const dayMatch = matchCronField(fields[2], dayOfMonth, 1, 31);
  const monthMatch = matchCronField(fields[3], month, 1, 12);
  const weekMatch = matchCronField(fields[4], dayOfWeek, 0, 7);

  return minuteMatch && hourMatch && dayMatch && monthMatch && weekMatch;
}

function toLocalTimeParts(now: Date): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  return {
    minute: now.getMinutes(),
    hour: now.getHours(),
    dayOfMonth: now.getDate(),
    month: now.getMonth() + 1,
    dayOfWeek: now.getDay()
  };
}

function toTimeParts(
  now: Date,
  timezone: string
): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hour12: false
  });
  const tokens = fmt.formatToParts(now);
  const minute = Number(tokens.find((item) => item.type === "minute")?.value ?? "0");
  const hourRaw = Number(tokens.find((item) => item.type === "hour")?.value ?? "0");
  const hour = ((hourRaw % 24) + 24) % 24;
  const dayOfMonth = Number(tokens.find((item) => item.type === "day")?.value ?? "1");
  const month = Number(tokens.find((item) => item.type === "month")?.value ?? "1");
  const weekdayText = (tokens.find((item) => item.type === "weekday")?.value ?? "Sun").toLowerCase();
  const dayOfWeekMap: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6
  };
  const dayOfWeek = dayOfWeekMap[weekdayText.slice(0, 3)] ?? 0;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function parseCronField(expr: string, min: number, max: number, label: string): number[] {
  const values = expandCronField(expr, min, max);
  if (values.length === 0) {
    throw new Error(`Invalid cron ${label} field '${expr}'`);
  }
  return values;
}

function matchCronField(expr: string, value: number, min: number, max: number): boolean {
  const values = expandCronField(expr, min, max);
  if (max === 7 && values.includes(7) && value === 0) {
    return true;
  }
  return values.includes(value);
}

function expandCronField(expr: string, min: number, max: number): number[] {
  const parts = expr.split(",");
  const out = new Set<number>();

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) {
      continue;
    }

    if (part === "*") {
      for (let value = min; value <= max; value += 1) {
        out.add(value);
      }
      continue;
    }

    const stepSplit = part.split("/");
    const base = stepSplit[0] ?? "";
    const stepRaw = stepSplit[1];
    const step = stepRaw ? Number(stepRaw) : 1;

    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step '${part}'`);
    }

    if (base === "*") {
      for (let value = min; value <= max; value += step) {
        out.add(value);
      }
      continue;
    }

    const rangeSplit = base.split("-");
    if (rangeSplit.length === 2) {
      const start = Number(rangeSplit[0]);
      const end = Number(rangeSplit[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw new Error(`Invalid cron range '${part}'`);
      }
      for (let value = start; value <= end; value += step) {
        if (value < min || value > max) {
          throw new Error(`Cron value out of bounds '${part}'`);
        }
        out.add(value);
      }
      continue;
    }

    const literal = Number(base);
    if (!Number.isInteger(literal) || literal < min || literal > max) {
      throw new Error(`Invalid cron value '${part}'`);
    }
    out.add(literal);
  }

  return [...out];
}
