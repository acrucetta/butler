import { z } from "zod";
export declare const JobKindSchema: z.ZodEnum<["task", "run"]>;
export type JobKind = z.infer<typeof JobKindSchema>;
export declare const JobStatusSchema: z.ZodEnum<["needs_approval", "queued", "running", "aborting", "aborted", "completed", "failed"]>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export declare const JobCreateRequestSchema: z.ZodObject<{
    kind: z.ZodDefault<z.ZodEnum<["task", "run"]>>;
    prompt: z.ZodString;
    channel: z.ZodLiteral<"telegram">;
    chatId: z.ZodString;
    threadId: z.ZodOptional<z.ZodString>;
    requesterId: z.ZodString;
    sessionKey: z.ZodString;
    requiresApproval: z.ZodDefault<z.ZodBoolean>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    kind: "task" | "run";
    prompt: string;
    channel: "telegram";
    chatId: string;
    requesterId: string;
    sessionKey: string;
    requiresApproval: boolean;
    threadId?: string | undefined;
    metadata?: Record<string, string> | undefined;
}, {
    prompt: string;
    channel: "telegram";
    chatId: string;
    requesterId: string;
    sessionKey: string;
    kind?: "task" | "run" | undefined;
    threadId?: string | undefined;
    requiresApproval?: boolean | undefined;
    metadata?: Record<string, string> | undefined;
}>;
export type JobCreateRequest = z.infer<typeof JobCreateRequestSchema>;
export declare const JobEventTypeSchema: z.ZodEnum<["job_created", "job_approved", "job_started", "agent_text_delta", "tool_start", "tool_end", "log", "job_finished", "job_failed", "job_aborted"]>;
export type JobEventType = z.infer<typeof JobEventTypeSchema>;
export declare const JobEventSchema: z.ZodObject<{
    type: z.ZodEnum<["job_created", "job_approved", "job_started", "agent_text_delta", "tool_start", "tool_end", "log", "job_finished", "job_failed", "job_aborted"]>;
    ts: z.ZodString;
    message: z.ZodOptional<z.ZodString>;
    data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
    ts: string;
    message?: string | undefined;
    data?: Record<string, unknown> | undefined;
}, {
    type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
    ts: string;
    message?: string | undefined;
    data?: Record<string, unknown> | undefined;
}>;
export type JobEvent = z.infer<typeof JobEventSchema>;
export declare const JobSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<["task", "run"]>;
    status: z.ZodEnum<["needs_approval", "queued", "running", "aborting", "aborted", "completed", "failed"]>;
    prompt: z.ZodString;
    channel: z.ZodLiteral<"telegram">;
    chatId: z.ZodString;
    threadId: z.ZodOptional<z.ZodString>;
    requesterId: z.ZodString;
    sessionKey: z.ZodString;
    requiresApproval: z.ZodBoolean;
    abortRequested: z.ZodDefault<z.ZodBoolean>;
    workerId: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    resultText: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    startedAt: z.ZodOptional<z.ZodString>;
    finishedAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "aborted" | "needs_approval" | "queued" | "running" | "aborting" | "completed" | "failed";
    kind: "task" | "run";
    prompt: string;
    channel: "telegram";
    chatId: string;
    requesterId: string;
    sessionKey: string;
    requiresApproval: boolean;
    id: string;
    abortRequested: boolean;
    createdAt: string;
    updatedAt: string;
    threadId?: string | undefined;
    metadata?: Record<string, string> | undefined;
    workerId?: string | undefined;
    resultText?: string | undefined;
    error?: string | undefined;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
}, {
    status: "aborted" | "needs_approval" | "queued" | "running" | "aborting" | "completed" | "failed";
    kind: "task" | "run";
    prompt: string;
    channel: "telegram";
    chatId: string;
    requesterId: string;
    sessionKey: string;
    requiresApproval: boolean;
    id: string;
    createdAt: string;
    updatedAt: string;
    threadId?: string | undefined;
    metadata?: Record<string, string> | undefined;
    abortRequested?: boolean | undefined;
    workerId?: string | undefined;
    resultText?: string | undefined;
    error?: string | undefined;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
}>;
export type Job = z.infer<typeof JobSchema>;
export declare const ClaimJobRequestSchema: z.ZodObject<{
    workerId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    workerId: string;
}, {
    workerId: string;
}>;
export type ClaimJobRequest = z.infer<typeof ClaimJobRequestSchema>;
export declare const ClaimJobResponseSchema: z.ZodObject<{
    job: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<["task", "run"]>;
        status: z.ZodEnum<["needs_approval", "queued", "running", "aborting", "aborted", "completed", "failed"]>;
        prompt: z.ZodString;
        channel: z.ZodLiteral<"telegram">;
        chatId: z.ZodString;
        threadId: z.ZodOptional<z.ZodString>;
        requesterId: z.ZodString;
        sessionKey: z.ZodString;
        requiresApproval: z.ZodBoolean;
        abortRequested: z.ZodDefault<z.ZodBoolean>;
        workerId: z.ZodOptional<z.ZodString>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        resultText: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        startedAt: z.ZodOptional<z.ZodString>;
        finishedAt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "aborted" | "needs_approval" | "queued" | "running" | "aborting" | "completed" | "failed";
        kind: "task" | "run";
        prompt: string;
        channel: "telegram";
        chatId: string;
        requesterId: string;
        sessionKey: string;
        requiresApproval: boolean;
        id: string;
        abortRequested: boolean;
        createdAt: string;
        updatedAt: string;
        threadId?: string | undefined;
        metadata?: Record<string, string> | undefined;
        workerId?: string | undefined;
        resultText?: string | undefined;
        error?: string | undefined;
        startedAt?: string | undefined;
        finishedAt?: string | undefined;
    }, {
        status: "aborted" | "needs_approval" | "queued" | "running" | "aborting" | "completed" | "failed";
        kind: "task" | "run";
        prompt: string;
        channel: "telegram";
        chatId: string;
        requesterId: string;
        sessionKey: string;
        requiresApproval: boolean;
        id: string;
        createdAt: string;
        updatedAt: string;
        threadId?: string | undefined;
        metadata?: Record<string, string> | undefined;
        abortRequested?: boolean | undefined;
        workerId?: string | undefined;
        resultText?: string | undefined;
        error?: string | undefined;
        startedAt?: string | undefined;
        finishedAt?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    job: {
        status: "aborted" | "needs_approval" | "queued" | "running" | "aborting" | "completed" | "failed";
        kind: "task" | "run";
        prompt: string;
        channel: "telegram";
        chatId: string;
        requesterId: string;
        sessionKey: string;
        requiresApproval: boolean;
        id: string;
        abortRequested: boolean;
        createdAt: string;
        updatedAt: string;
        threadId?: string | undefined;
        metadata?: Record<string, string> | undefined;
        workerId?: string | undefined;
        resultText?: string | undefined;
        error?: string | undefined;
        startedAt?: string | undefined;
        finishedAt?: string | undefined;
    } | null;
}, {
    job: {
        status: "aborted" | "needs_approval" | "queued" | "running" | "aborting" | "completed" | "failed";
        kind: "task" | "run";
        prompt: string;
        channel: "telegram";
        chatId: string;
        requesterId: string;
        sessionKey: string;
        requiresApproval: boolean;
        id: string;
        createdAt: string;
        updatedAt: string;
        threadId?: string | undefined;
        metadata?: Record<string, string> | undefined;
        abortRequested?: boolean | undefined;
        workerId?: string | undefined;
        resultText?: string | undefined;
        error?: string | undefined;
        startedAt?: string | undefined;
        finishedAt?: string | undefined;
    } | null;
}>;
export type ClaimJobResponse = z.infer<typeof ClaimJobResponseSchema>;
export declare const JobEventsResponseSchema: z.ZodObject<{
    events: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["job_created", "job_approved", "job_started", "agent_text_delta", "tool_start", "tool_end", "log", "job_finished", "job_failed", "job_aborted"]>;
        ts: z.ZodString;
        message: z.ZodOptional<z.ZodString>;
        data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
        ts: string;
        message?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }, {
        type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
        ts: string;
        message?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }>, "many">;
    nextCursor: z.ZodNumber;
    total: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    events: {
        type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
        ts: string;
        message?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }[];
    nextCursor: number;
    total: number;
}, {
    events: {
        type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
        ts: string;
        message?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }[];
    nextCursor: number;
    total: number;
}>;
export type JobEventsResponse = z.infer<typeof JobEventsResponseSchema>;
export declare const WorkerEventRequestSchema: z.ZodObject<{
    event: z.ZodObject<{
        type: z.ZodEnum<["job_created", "job_approved", "job_started", "agent_text_delta", "tool_start", "tool_end", "log", "job_finished", "job_failed", "job_aborted"]>;
        ts: z.ZodString;
        message: z.ZodOptional<z.ZodString>;
        data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
        ts: string;
        message?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }, {
        type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
        ts: string;
        message?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    event: {
        type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
        ts: string;
        message?: string | undefined;
        data?: Record<string, unknown> | undefined;
    };
}, {
    event: {
        type: "job_created" | "job_approved" | "job_started" | "agent_text_delta" | "tool_start" | "tool_end" | "log" | "job_finished" | "job_failed" | "job_aborted";
        ts: string;
        message?: string | undefined;
        data?: Record<string, unknown> | undefined;
    };
}>;
export type WorkerEventRequest = z.infer<typeof WorkerEventRequestSchema>;
export declare const WorkerCompleteRequestSchema: z.ZodObject<{
    resultText: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    resultText: string;
}, {
    resultText?: string | undefined;
}>;
export type WorkerCompleteRequest = z.infer<typeof WorkerCompleteRequestSchema>;
export declare const WorkerFailRequestSchema: z.ZodObject<{
    error: z.ZodString;
}, "strip", z.ZodTypeAny, {
    error: string;
}, {
    error: string;
}>;
export type WorkerFailRequest = z.infer<typeof WorkerFailRequestSchema>;
export declare const WorkerHeartbeatResponseSchema: z.ZodObject<{
    abortRequested: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    abortRequested: boolean;
}, {
    abortRequested: boolean;
}>;
export type WorkerHeartbeatResponse = z.infer<typeof WorkerHeartbeatResponseSchema>;
export declare const jobTerminalStates: JobStatus[];
export declare function isTerminalStatus(status: JobStatus): boolean;
