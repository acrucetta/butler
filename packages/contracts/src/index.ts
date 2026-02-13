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

export const jobTerminalStates: JobStatus[] = ["aborted", "completed", "failed"];

export function isTerminalStatus(status: JobStatus): boolean {
  return jobTerminalStates.includes(status);
}
