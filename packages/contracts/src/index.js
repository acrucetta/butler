import { z } from "zod";
export const JobKindSchema = z.enum(["task", "run"]);
export const JobStatusSchema = z.enum([
    "needs_approval",
    "queued",
    "running",
    "aborting",
    "aborted",
    "completed",
    "failed"
]);
export const JobCreateRequestSchema = z.object({
    kind: JobKindSchema.default("task"),
    prompt: z.string().min(1),
    channel: z.literal("telegram"),
    chatId: z.string(),
    threadId: z.string().optional(),
    requesterId: z.string(),
    sessionKey: z.string().min(1),
    requiresApproval: z.boolean().default(false),
    metadata: z.record(z.string()).optional()
});
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
export const JobEventSchema = z.object({
    type: JobEventTypeSchema,
    ts: z.string(),
    message: z.string().optional(),
    data: z.record(z.unknown()).optional()
});
export const JobSchema = z.object({
    id: z.string(),
    kind: JobKindSchema,
    status: JobStatusSchema,
    prompt: z.string(),
    channel: z.literal("telegram"),
    chatId: z.string(),
    threadId: z.string().optional(),
    requesterId: z.string(),
    sessionKey: z.string(),
    requiresApproval: z.boolean(),
    abortRequested: z.boolean().default(false),
    workerId: z.string().optional(),
    metadata: z.record(z.string()).optional(),
    resultText: z.string().optional(),
    error: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional()
});
export const ClaimJobRequestSchema = z.object({
    workerId: z.string().min(1)
});
export const ClaimJobResponseSchema = z.object({
    job: JobSchema.nullable()
});
export const JobEventsResponseSchema = z.object({
    events: z.array(JobEventSchema),
    nextCursor: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
});
export const WorkerEventRequestSchema = z.object({
    event: JobEventSchema
});
export const WorkerCompleteRequestSchema = z.object({
    resultText: z.string().default("")
});
export const WorkerFailRequestSchema = z.object({
    error: z.string().min(1)
});
export const WorkerHeartbeatResponseSchema = z.object({
    abortRequested: z.boolean()
});
export const jobTerminalStates = ["aborted", "completed", "failed"];
export function isTerminalStatus(status) {
    return jobTerminalStates.includes(status);
}
//# sourceMappingURL=index.js.map