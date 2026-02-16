import type { Job, JobCreateRequest, JobKind } from "@pi-self/contracts";
import { z } from "zod";
import type { OrchestratorStore } from "./store.js";

const ProactiveTargetSchema = z.object({
  kind: z.enum(["task", "run"]).default("task"),
  chatId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128).optional(),
  requesterId: z.string().min(1).max(128),
  sessionKey: z.string().min(1).max(256),
  requiresApproval: z.boolean().default(true),
  metadata: z.record(z.string().max(2_000)).optional()
});

const HeartbeatRuleSchema = z.object({
  id: z.string().min(1).max(120),
  everySeconds: z.number().int().min(5).max(86_400),
  prompt: z.string().min(1).max(20_000),
  target: ProactiveTargetSchema
});

const CronRuleSchema = z.object({
  id: z.string().min(1).max(120),
  cron: z.string().min(1).max(120),
  prompt: z.string().min(1).max(20_000),
  target: ProactiveTargetSchema
});

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
  heartbeatRules: z.array(HeartbeatRuleSchema).default([]),
  cronRules: z.array(CronRuleSchema).default([]),
  webhooks: z.array(WebhookRuleSchema).default([]),
  webhookPayloadMaxChars: z.number().int().min(256).max(200_000).default(8_000)
});

type ProactiveConfig = z.infer<typeof ProactiveConfigSchema>;
type ProactiveTarget = z.infer<typeof ProactiveTargetSchema>;
type HeartbeatRule = z.infer<typeof HeartbeatRuleSchema>;
type CronRule = z.infer<typeof CronRuleSchema>;
type WebhookRule = z.infer<typeof WebhookRuleSchema>;

type TriggerKind = "heartbeat" | "cron" | "webhook";
const MAX_JOB_PROMPT_CHARS = 20_000;

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
  status: "enqueued" | "duplicate_active_job" | "unauthorized" | "not_found";
  jobId?: string;
}

export class ProactiveRuntime {
  private readonly config: ProactiveConfig;
  private readonly webhookById: Map<string, WebhookRule>;
  private readonly nextHeartbeatAtMs = new Map<string, number>();
  private readonly lastCronMinuteKey = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly stats: RuntimeStats = {};

  constructor(
    private readonly store: OrchestratorStore,
    rawConfig: unknown,
    private readonly logger: Pick<Console, "log" | "error"> = console
  ) {
    this.config = parseConfig(rawConfig);
    this.webhookById = new Map(this.config.webhooks.map((item) => [item.id, item]));

    const now = Date.now();
    for (const rule of this.config.heartbeatRules) {
      this.nextHeartbeatAtMs.set(rule.id, now + rule.everySeconds * 1000);
    }
  }

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

    const job = this.enqueue("webhook", rule.id, prompt, rule.target, metadata);
    if (!job) {
      return { status: "duplicate_active_job" };
    }

    return {
      status: "enqueued",
      jobId: job.id
    };
  }

  private async tick(): Promise<void> {
    try {
      const now = new Date();
      const nowMs = now.getTime();

      this.stats.lastHeartbeatTickAt = now.toISOString();
      for (const rule of this.config.heartbeatRules) {
        const dueAt = this.nextHeartbeatAtMs.get(rule.id) ?? nowMs;
        if (nowMs < dueAt) {
          continue;
        }

        this.enqueue("heartbeat", rule.id, rule.prompt, rule.target);
        this.nextHeartbeatAtMs.set(rule.id, nowMs + rule.everySeconds * 1000);
      }

      this.stats.lastCronTickAt = now.toISOString();
      const minuteKey = toMinuteKey(now);
      for (const rule of this.config.cronRules) {
        if (!matchesCronExpression(rule.cron, now)) {
          continue;
        }

        if (this.lastCronMinuteKey.get(rule.id) === minuteKey) {
          continue;
        }

        this.enqueue("cron", rule.id, rule.prompt, rule.target);
        this.lastCronMinuteKey.set(rule.id, minuteKey);
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
    metadata?: Record<string, string>
  ): Job | undefined {
    const triggerKey = `${kind}:${triggerId}`;
    if (this.store.hasActiveJobByMetadata("proactiveTriggerKey", triggerKey)) {
      return undefined;
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
        proactivePromptTruncated: String(prompt.length > MAX_JOB_PROMPT_CHARS)
      }
    };

    const job = this.store.createJob(request);
    this.logger.log(`[orchestrator] proactive enqueue kind=${kind} trigger=${triggerId} job=${job.id}`);
    return job;
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
    assertCronExpression(rule.cron);
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

function matchesCronExpression(expr: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }

  const minute = now.getMinutes();
  const hour = now.getHours();
  const dayOfMonth = now.getDate();
  const month = now.getMonth() + 1;
  const dayOfWeek = now.getDay();

  const minuteMatch = matchCronField(fields[0], minute, 0, 59);
  const hourMatch = matchCronField(fields[1], hour, 0, 23);
  const dayMatch = matchCronField(fields[2], dayOfMonth, 1, 31);
  const monthMatch = matchCronField(fields[3], month, 1, 12);
  const weekMatch = matchCronField(fields[4], dayOfWeek, 0, 7);

  return minuteMatch && hourMatch && dayMatch && monthMatch && weekMatch;
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
