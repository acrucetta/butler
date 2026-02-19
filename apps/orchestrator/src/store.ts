import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isTerminalStatus, type Job, type JobCreateRequest, type JobEvent, type JobStatus } from "@pi-self/contracts";

interface PersistedState {
  jobs: Record<string, Job>;
  events: Record<string, JobEvent[]>;
  queue: string[];
  paused: boolean;
  pauseReason?: string;
  pauseUpdatedAt: string;
}

const initialState: PersistedState = {
  jobs: {},
  events: {},
  queue: [],
  paused: false,
  pauseUpdatedAt: nowIso()
};

const MAX_EVENTS_PER_JOB = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

function cloneState(state: PersistedState): PersistedState {
  return JSON.parse(JSON.stringify(state)) as PersistedState;
}

export class OrchestratorStore {
  private state: PersistedState;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.state = this.load();
  }

  createJob(input: JobCreateRequest): Job {
    const id = randomUUID();
    const createdAt = nowIso();
    const status: JobStatus = input.requiresApproval ? "needs_approval" : "queued";

    const job: Job = {
      id,
      kind: input.kind,
      status,
      prompt: input.prompt,
      channel: input.channel,
      chatId: input.chatId,
      threadId: input.threadId,
      requesterId: input.requesterId,
      sessionKey: input.sessionKey,
      requiresApproval: input.requiresApproval,
      abortRequested: false,
      metadata: input.metadata,
      createdAt,
      updatedAt: createdAt
    };

    this.state.jobs[id] = job;
    this.pushEvent(id, {
      type: "job_created",
      ts: createdAt,
      message: input.requiresApproval
        ? "Job created and waiting for approval"
        : "Job created and queued"
    });

    if (status === "queued") {
      this.state.queue.push(id);
    }

    this.save();
    return job;
  }

  getJob(id: string): Job | undefined {
    const job = this.state.jobs[id];
    if (!job) return undefined;
    return structuredClone(job);
  }

  getEvents(id: string, cursor: number): { events: JobEvent[]; nextCursor: number; total: number } {
    const events = this.ensureEvents(id);
    const safeCursor = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0;
    const sliced = events.slice(safeCursor);
    return {
      events: structuredClone(sliced),
      nextCursor: events.length,
      total: events.length
    };
  }

  approveJob(id: string): Job | undefined {
    const job = this.state.jobs[id];
    if (!job) return undefined;

    if (job.status === "needs_approval") {
      job.status = "queued";
      job.updatedAt = nowIso();
      this.state.queue.push(id);
      this.pushEvent(id, {
        type: "job_approved",
        ts: nowIso(),
        message: "Job approved and queued"
      });
      this.save();
    }

    return structuredClone(job);
  }

  requestAbort(id: string): Job | undefined {
    const job = this.state.jobs[id];
    if (!job) return undefined;

    if (job.status === "queued" || job.status === "needs_approval") {
      job.status = "aborted";
      job.abortRequested = true;
      job.updatedAt = nowIso();
      job.finishedAt = nowIso();
      this.removeFromQueue(id);
      this.pushEvent(id, {
        type: "job_aborted",
        ts: nowIso(),
        message: "Job aborted before execution"
      });
      this.save();
      return structuredClone(job);
    }

    if (job.status === "running") {
      job.abortRequested = true;
      job.status = "aborting";
      job.updatedAt = nowIso();
      this.pushEvent(id, {
        type: "log",
        ts: nowIso(),
        message: "Abort requested"
      });
      this.save();
    }

    return structuredClone(job);
  }

  claimNextQueuedJob(workerId: string): Job | undefined {
    if (this.state.paused) {
      return undefined;
    }

    while (this.state.queue.length > 0) {
      const id = this.state.queue.shift();
      if (!id) break;
      const job = this.state.jobs[id];
      if (!job) continue;
      if (job.status !== "queued") continue;

      job.status = "running";
      job.workerId = workerId;
      job.startedAt = nowIso();
      job.updatedAt = nowIso();
      this.pushEvent(id, {
        type: "job_started",
        ts: nowIso(),
        message: `Job claimed by worker ${workerId}`
      });
      this.save();
      return structuredClone(job);
    }

    return undefined;
  }

  appendWorkerEvent(jobId: string, event: JobEvent): Job | undefined {
    const job = this.state.jobs[jobId];
    if (!job) return undefined;

    this.pushEvent(jobId, event);
    job.updatedAt = nowIso();

    if (event.type === "agent_text_delta" && event.data && typeof event.data.delta === "string") {
      const previous = job.resultText ?? "";
      job.resultText = previous + event.data.delta;
    }

    this.save();
    return structuredClone(job);
  }

  getAbortRequested(jobId: string): boolean {
    const job = this.state.jobs[jobId];
    return Boolean(job?.abortRequested);
  }

  completeJob(jobId: string, resultText: string): Job | undefined {
    const job = this.state.jobs[jobId];
    if (!job) return undefined;

    job.status = job.abortRequested ? "aborted" : "completed";
    job.resultText = resultText;
    job.error = undefined;
    job.updatedAt = nowIso();
    job.finishedAt = nowIso();

    this.pushEvent(jobId, {
      type: job.status === "aborted" ? "job_aborted" : "job_finished",
      ts: nowIso(),
      message:
        job.status === "aborted"
          ? "Job stopped after abort request"
          : "Job finished successfully"
    });

    this.save();
    return structuredClone(job);
  }

  failJob(jobId: string, error: string): Job | undefined {
    const job = this.state.jobs[jobId];
    if (!job) return undefined;

    job.status = "failed";
    job.error = error;
    job.updatedAt = nowIso();
    job.finishedAt = nowIso();

    this.pushEvent(jobId, {
      type: "job_failed",
      ts: nowIso(),
      message: error
    });

    this.save();
    return structuredClone(job);
  }

  markAborted(jobId: string, reason?: string): Job | undefined {
    const job = this.state.jobs[jobId];
    if (!job) return undefined;

    job.status = "aborted";
    job.abortRequested = true;
    job.updatedAt = nowIso();
    job.finishedAt = nowIso();

    this.pushEvent(jobId, {
      type: "job_aborted",
      ts: nowIso(),
      message: reason ?? "Job aborted by worker"
    });

    this.save();
    return structuredClone(job);
  }

  hasActiveJobByMetadata(key: string, value: string): boolean {
    for (const job of Object.values(this.state.jobs)) {
      if (isTerminalStatus(job.status)) {
        continue;
      }

      if (job.metadata?.[key] === value) {
        return true;
      }
    }

    return false;
  }

  getLatestTerminalJobByMetadata(key: string, value: string): Job | undefined {
    let latest: Job | undefined;
    for (const job of Object.values(this.state.jobs)) {
      if (!isTerminalStatus(job.status)) {
        continue;
      }
      if (job.metadata?.[key] !== value) {
        continue;
      }
      if (!latest) {
        latest = job;
        continue;
      }
      const currentTs = Date.parse(job.updatedAt);
      const latestTs = Date.parse(latest.updatedAt);
      if (currentTs >= latestTs) {
        latest = job;
      }
    }
    return latest ? structuredClone(latest) : undefined;
  }

  listProactiveRuns(limit: number, triggerKey?: string): Job[] {
    const capped = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
    const runs = Object.values(this.state.jobs)
      .filter((job) => typeof job.metadata?.proactiveTriggerKey === "string")
      .filter((job) => (triggerKey ? job.metadata?.proactiveTriggerKey === triggerKey : true))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, capped);
    return runs.map((job) => structuredClone(job));
  }

  getAdminState(): { paused: boolean; pauseReason?: string; updatedAt: string } {
    return {
      paused: this.state.paused,
      pauseReason: this.state.pauseReason,
      updatedAt: this.state.pauseUpdatedAt
    };
  }

  setPaused(paused: boolean, reason?: string): { paused: boolean; pauseReason?: string; updatedAt: string } {
    this.state.paused = paused;
    this.state.pauseReason = paused ? reason : undefined;
    this.state.pauseUpdatedAt = nowIso();
    this.save();
    return this.getAdminState();
  }

  listPendingProactiveDeliveries(limit: number): Job[] {
    const capped = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20;
    const out: Job[] = [];
    for (const job of Object.values(this.state.jobs)) {
      if (!isTerminalStatus(job.status)) {
        continue;
      }

      const mode = job.metadata?.proactiveDeliveryMode;
      if (mode !== "announce" && mode !== "webhook") {
        continue;
      }

      if (job.metadata?.proactiveDeliveredAt) {
        continue;
      }

      out.push(structuredClone(job));
      if (out.length >= capped) {
        break;
      }
    }
    return out;
  }

  markProactiveDelivery(jobId: string, receipt: string): Job | undefined {
    const job = this.state.jobs[jobId];
    if (!job) {
      return undefined;
    }

    const metadata = { ...(job.metadata ?? {}) };
    metadata.proactiveDeliveredAt = nowIso();
    metadata.proactiveDeliveryReceipt = receipt.slice(0, 2_000);
    job.metadata = metadata;
    job.updatedAt = nowIso();
    this.save();
    return structuredClone(job);
  }

  private removeFromQueue(id: string): void {
    this.state.queue = this.state.queue.filter((queuedId) => queuedId !== id);
  }

  private ensureEvents(id: string): JobEvent[] {
    if (!this.state.events[id]) {
      this.state.events[id] = [];
    }
    return this.state.events[id];
  }

  private pushEvent(id: string, event: JobEvent): void {
    const events = this.ensureEvents(id);
    events.push(event);
    if (events.length > MAX_EVENTS_PER_JOB) {
      const overflow = events.length - MAX_EVENTS_PER_JOB;
      events.splice(0, overflow);
    }
  }

  private load(): PersistedState {
    if (!existsSync(this.filePath)) {
      return cloneState(initialState);
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      return {
        jobs: parsed.jobs ?? {},
        events: parsed.events ?? {},
        queue: parsed.queue ?? [],
        paused: parsed.paused ?? false,
        pauseReason: parsed.pauseReason,
        pauseUpdatedAt: parsed.pauseUpdatedAt ?? nowIso()
      };
    } catch {
      return cloneState(initialState);
    }
  }

  private save(): void {
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }
}
