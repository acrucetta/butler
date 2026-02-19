import { z } from "zod";

export const JobKindSchema = z.enum(["task", "run"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum([
  "needs_approval",
  "queued",
  "running",
  "aborting",
  "aborted",
  "completed",
  "failed"
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobCreateRequestSchema = z.object({
  kind: JobKindSchema.default("task"),
  prompt: z.string().min(1).max(20_000),
  channel: z.literal("telegram"),
  chatId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128).optional(),
  requesterId: z.string().min(1).max(128),
  sessionKey: z.string().min(1).max(256),
  requiresApproval: z.boolean().default(false),
  metadata: z.record(z.string().max(2_000)).optional()
});
export type JobCreateRequest = z.infer<typeof JobCreateRequestSchema>;

export const JobEventTypeSchema = z.enum([
  "job_created",
  "job_approved",
  "job_started",
  "agent_text_delta",
  "tool_start",
  "tool_end",
  "log",
  "job_finished",
  "job_failed",
  "job_aborted"
]);
export type JobEventType = z.infer<typeof JobEventTypeSchema>;

export const JobEventSchema = z.object({
  type: JobEventTypeSchema,
  ts: z.string(),
  message: z.string().max(4_000).optional(),
  data: z.record(z.unknown()).optional()
});
export type JobEvent = z.infer<typeof JobEventSchema>;

export const JobSchema = z.object({
  id: z.string(),
  kind: JobKindSchema,
  status: JobStatusSchema,
  prompt: z.string().max(20_000),
  channel: z.literal("telegram"),
  chatId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128).optional(),
  requesterId: z.string().min(1).max(128),
  sessionKey: z.string().min(1).max(256),
  requiresApproval: z.boolean(),
  abortRequested: z.boolean().default(false),
  workerId: z.string().optional(),
  metadata: z.record(z.string().max(2_000)).optional(),
  resultText: z.string().max(2_000_000).optional(),
  error: z.string().max(8_000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional()
});
export type Job = z.infer<typeof JobSchema>;

export const ClaimJobRequestSchema = z.object({
  workerId: z.string().min(1)
});
export type ClaimJobRequest = z.infer<typeof ClaimJobRequestSchema>;

export const ClaimJobResponseSchema = z.object({
  job: JobSchema.nullable()
});
export type ClaimJobResponse = z.infer<typeof ClaimJobResponseSchema>;

export const JobEventsResponseSchema = z.object({
  events: z.array(JobEventSchema),
  nextCursor: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
});
export type JobEventsResponse = z.infer<typeof JobEventsResponseSchema>;

export const WorkerEventRequestSchema = z.object({
  event: JobEventSchema
});
export type WorkerEventRequest = z.infer<typeof WorkerEventRequestSchema>;

export const WorkerCompleteRequestSchema = z.object({
  resultText: z.string().max(2_000_000).default("")
});
export type WorkerCompleteRequest = z.infer<typeof WorkerCompleteRequestSchema>;

export const WorkerFailRequestSchema = z.object({
  error: z.string().min(1).max(8_000)
});
export type WorkerFailRequest = z.infer<typeof WorkerFailRequestSchema>;

export const WorkerHeartbeatResponseSchema = z.object({
  abortRequested: z.boolean()
});
export type WorkerHeartbeatResponse = z.infer<typeof WorkerHeartbeatResponseSchema>;

export const AdminStateSchema = z.object({
  paused: z.boolean(),
  pauseReason: z.string().optional(),
  updatedAt: z.string()
});
export type AdminState = z.infer<typeof AdminStateSchema>;

export const ProactiveTargetSchema = z.object({
  kind: JobKindSchema.default("task"),
  chatId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128).optional(),
  requesterId: z.string().min(1).max(128),
  sessionKey: z.string().min(1).max(256),
  requiresApproval: z.boolean().default(false),
  metadata: z.record(z.string().max(2_000)).optional()
});
export type ProactiveTarget = z.infer<typeof ProactiveTargetSchema>;

export const ProactiveHeartbeatRuleSchema = z.object({
  id: z.string().min(1).max(120),
  everySeconds: z.number().int().min(5).max(86_400),
  prompt: z.string().min(1).max(20_000),
  delivery: z
    .object({
      mode: z.enum(["announce", "webhook", "none"]).default("announce"),
      webhookUrl: z.string().url().max(2_000).optional()
    })
    .default({ mode: "announce" }),
  target: ProactiveTargetSchema
}).superRefine((value, ctx) => {
  if (value.delivery.mode === "webhook" && !value.delivery.webhookUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "delivery.webhookUrl is required when delivery.mode is webhook"
    });
  }
});
export type ProactiveHeartbeatRule = z.infer<typeof ProactiveHeartbeatRuleSchema>;

export const ProactiveCronRuleSchema = z.object({
  id: z.string().min(1).max(120),
  cron: z.string().min(1).max(120).optional(),
  at: z.string().min(1).max(120).optional(),
  everySeconds: z.number().int().min(5).max(86_400).optional(),
  timezone: z.string().min(1).max(80).optional(),
  sessionTarget: z.enum(["main", "isolated"]).default("isolated"),
  wakeMode: z.enum(["now", "next-heartbeat"]).default("now"),
  prompt: z.string().min(1).max(20_000),
  delivery: z
    .object({
      mode: z.enum(["announce", "webhook", "none"]).default("announce"),
      webhookUrl: z.string().url().max(2_000).optional()
    })
    .default({ mode: "announce" }),
  target: ProactiveTargetSchema
}).superRefine((value, ctx) => {
  const populated = [Boolean(value.cron), Boolean(value.at), Boolean(value.everySeconds)].filter(Boolean).length;
  if (populated !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one schedule field is required: cron | at | everySeconds"
    });
  }

  if (value.delivery.mode === "webhook" && !value.delivery.webhookUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "delivery.webhookUrl is required when delivery.mode is webhook"
    });
  }

  if (value.everySeconds && value.timezone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "timezone is not applicable to everySeconds schedules"
    });
  }

  if (value.sessionTarget === "isolated" && value.wakeMode === "next-heartbeat") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "wakeMode=next-heartbeat requires sessionTarget=main"
    });
  }
});
export type ProactiveCronRule = z.infer<typeof ProactiveCronRuleSchema>;

export const ProactiveRuleDeleteRequestSchema = z.object({
  id: z.string().min(1).max(120)
});
export type ProactiveRuleDeleteRequest = z.infer<typeof ProactiveRuleDeleteRequestSchema>;

export const ProactiveConfigSummarySchema = z.object({
  enabled: z.boolean(),
  tickMs: z.number().int().min(500).max(60_000),
  heartbeatRules: z.array(ProactiveHeartbeatRuleSchema),
  cronRules: z.array(ProactiveCronRuleSchema),
  webhookRules: z.array(z.object({ id: z.string().min(1).max(120) }))
});
export type ProactiveConfigSummary = z.infer<typeof ProactiveConfigSummarySchema>;

export const jobTerminalStates: JobStatus[] = ["aborted", "completed", "failed"];

export function isTerminalStatus(status: JobStatus): boolean {
  return jobTerminalStates.includes(status);
}
