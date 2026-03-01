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
  serviceStatus?: unknown;
  proactiveLastDelivered: Record<string, { text: string; ts: string }>;
}

const initialState: PersistedState = {
  jobs: {},
  events: {},
  queue: [],
  paused: false,
  pauseUpdatedAt: nowIso(),
  serviceStatus: undefined,
  proactiveLastDelivered: {}
};

const MAX_EVENTS_PER_JOB = 5_000;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const DEDUP_SIMILARITY_THRESHOLD = 0.85; // 85% word overlap = "same message"

/** Normalize text for comparison: strip markdown formatting and collapse whitespace. */
function normalizeForDedup(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")      // strip heading markers
    .replace(/^[-*]\s*\[[ x]]\s*/gm, "") // strip checkbox bullets
    .replace(/^[-*+]\s+/gm, "")       // strip plain bullets
    .replace(/[*_~`]/g, "")           // strip emphasis/code markers
    .replace(/\s+/g, " ")            // collapse whitespace
    .trim()
    .toLowerCase();
}

/** Word-overlap similarity ratio (Jaccard-like on word multisets). */
function textSimilarity(a: string, b: string): number {
  const wordsA = normalizeForDedup(a).split(" ").filter(Boolean);
  const wordsB = normalizeForDedup(b).split(" ").filter(Boolean);
  if (wordsA.length === 0 && wordsB.length === 0) return 1;
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const bagB = new Map<string, number>();
  for (const w of wordsB) bagB.set(w, (bagB.get(w) ?? 0) + 1);

  let shared = 0;
  for (const w of wordsA) {
    const count = bagB.get(w) ?? 0;
    if (count > 0) {
      shared++;
      bagB.set(w, count - 1);
    }
  }

  // ratio of shared words to the larger set size
  return shared / Math.max(wordsA.length, wordsB.length);
}

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
      if (this.skipDuplicateIdempotentJob(job)) {
        continue;
      }

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

  setServiceStatus(status: unknown): void {
    this.state.serviceStatus = status;
    this.save();
  }

  getServiceStatus(): unknown {
    return structuredClone(this.state.serviceStatus);
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

  touchJobHeartbeat(jobId: string): boolean {
    const job = this.state.jobs[jobId];
    if (!job) {
      return false;
    }
    if (job.status !== "running" && job.status !== "aborting") {
      return false;
    }

    job.updatedAt = nowIso();
    this.save();
    return true;
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

      // Heartbeat dedup: suppress if identical to last delivered text within TTL
      if (this.isDuplicateHeartbeat(job)) {
        this.autoAckDuplicate(job);
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

    // Track last delivered text for heartbeat dedup
    const triggerKey = metadata.proactiveTriggerKey;
    if (typeof triggerKey === "string" && job.resultText) {
      this.state.proactiveLastDelivered[triggerKey] = {
        text: job.resultText.trim(),
        ts: nowIso()
      };
    }

    this.save();
    return structuredClone(job);
  }

  reapStaleActiveJobs(maxIdleMs: number, nowMs = Date.now()): Job[] {
    if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) {
      return [];
    }

    const now = Math.floor(nowMs);
    const reaped: Job[] = [];
    for (const job of Object.values(this.state.jobs)) {
      if (job.status !== "running" && job.status !== "aborting") {
        continue;
      }

      const updatedMs = Date.parse(job.updatedAt);
      if (!Number.isFinite(updatedMs)) {
        continue;
      }
      if (now - updatedMs < maxIdleMs) {
        continue;
      }

      if (job.status === "aborting") {
        job.status = "aborted";
        job.abortRequested = true;
        job.updatedAt = nowIso();
        job.finishedAt = job.updatedAt;
        this.pushEvent(job.id, {
          type: "job_aborted",
          ts: job.updatedAt,
          message: "Job auto-aborted by stale-job reaper (worker heartbeat timeout)"
        });
      } else {
        job.status = "failed";
        job.error = "stale_running_timeout: worker heartbeat timeout";
        job.updatedAt = nowIso();
        job.finishedAt = job.updatedAt;
        this.pushEvent(job.id, {
          type: "job_failed",
          ts: job.updatedAt,
          message: "Job auto-failed by stale-job reaper (worker heartbeat timeout)"
        });
      }

      reaped.push(structuredClone(job));
    }

    if (reaped.length > 0) {
      this.save();
    }

    return reaped;
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
        pauseUpdatedAt: parsed.pauseUpdatedAt ?? nowIso(),
        serviceStatus: parsed.serviceStatus,
        proactiveLastDelivered: parsed.proactiveLastDelivered ?? {}
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

  clearLastDelivered(triggerKey?: string): number {
    if (triggerKey) {
      const had = triggerKey in this.state.proactiveLastDelivered ? 1 : 0;
      delete this.state.proactiveLastDelivered[triggerKey];
      this.save();
      return had;
    }
    const count = Object.keys(this.state.proactiveLastDelivered).length;
    this.state.proactiveLastDelivered = {};
    this.save();
    return count;
  }

  private isDuplicateHeartbeat(job: Job): boolean {
    if (job.metadata?.proactiveTriggerKind !== "heartbeat") return false;

    const triggerKey = job.metadata?.proactiveTriggerKey;
    if (typeof triggerKey !== "string") return false;

    const last = this.state.proactiveLastDelivered[triggerKey];
    if (!last) return false;

    const age = Date.now() - Date.parse(last.ts);
    if (age > DEDUP_TTL_MS) return false;

    const currentText = (job.resultText ?? "").trim();
    const similarity = textSimilarity(currentText, last.text);
    if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
      console.log(`[dedup] similarity=${(similarity * 100).toFixed(1)}% (threshold=${DEDUP_SIMILARITY_THRESHOLD * 100}%) for trigger=${triggerKey}`);
      return true;
    }
    return false;
  }

  private autoAckDuplicate(job: Job): void {
    const ts = nowIso();
    const metadata = { ...(job.metadata ?? {}) };
    metadata.proactiveDeliveredAt = ts;
    metadata.proactiveDeliveryReceipt = `duplicate-suppressed:${ts}`;
    job.metadata = metadata;
    job.updatedAt = ts;
    console.log(`[dedup] suppressed duplicate heartbeat delivery for job ${job.id} (trigger: ${metadata.proactiveTriggerKey})`);
    this.save();
  }

  private skipDuplicateIdempotentJob(job: Job): boolean {
    const key = job.metadata?.proactiveIdempotencyKey;
    if (!key) {
      return false;
    }

    const latest = this.getLatestTerminalJobByMetadata("proactiveIdempotencyKey", key);
    if (!latest || latest.status !== "completed" || latest.id === job.id) {
      return false;
    }

    job.status = "completed";
    job.resultText = "__SKIPPED_IDEMPOTENT__";
    job.error = undefined;
    job.updatedAt = nowIso();
    job.finishedAt = nowIso();
    this.pushEvent(job.id, {
      type: "job_finished",
      ts: nowIso(),
      message: `Job skipped due to idempotency key ${key}`
    });
    this.save();
    return true;
  }
}
