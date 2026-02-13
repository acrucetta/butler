import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AdminStateSchema,
  ClaimJobRequestSchema,
  JobCreateRequestSchema,
  JobEventsResponseSchema,
  JobSchema,
  WorkerCompleteRequestSchema,
  WorkerEventRequestSchema,
  WorkerFailRequestSchema,
  WorkerHeartbeatResponseSchema
} from "@pi-self/contracts";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { OrchestratorStore } from "./store.js";

const port = Number(process.env.ORCH_PORT ?? "8787");
const host = process.env.ORCH_HOST ?? "127.0.0.1";
const statePath = resolve(process.env.ORCH_STATE_FILE ?? ".data/orchestrator/state.json");
const gatewayToken = requireSecret("ORCH_GATEWAY_TOKEN", process.env.ORCH_GATEWAY_TOKEN);
const workerToken = requireSecret("ORCH_WORKER_TOKEN", process.env.ORCH_WORKER_TOKEN);

mkdirSync(dirname(statePath), { recursive: true });
const store = new OrchestratorStore(statePath);
const app = express();

app.use(express.json({ limit: "1mb" }));
app.disable("x-powered-by");
app.use((req, _res, next) => {
  req.socket.setTimeout(60_000);
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    admin: AdminStateSchema.parse(store.getAdminState())
  });
});

app.post("/v1/jobs", requireApiKey(gatewayToken), (req, res, next) => {
  try {
    const parsed = JobCreateRequestSchema.parse(req.body);
    const job = store.createJob(parsed);
    res.status(201).json({ job });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/jobs/:jobId", requireApiKey(gatewayToken), (req, res) => {
  const job = store.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "job_not_found" });
    return;
  }
  res.json({ job: JobSchema.parse(job) });
});

app.get("/v1/jobs/:jobId/events", requireApiKey(gatewayToken), (req, res, next) => {
  try {
    const cursor = Number(req.query.cursor ?? "0");
    const result = store.getEvents(req.params.jobId, cursor);
    res.json(JobEventsResponseSchema.parse(result));
  } catch (error) {
    next(error);
  }
});

app.post("/v1/jobs/:jobId/approve", requireApiKey(gatewayToken), (req, res) => {
  const job = store.approveJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "job_not_found" });
    return;
  }
  res.json({ job });
});

app.post("/v1/jobs/:jobId/abort", requireApiKey(gatewayToken), (req, res) => {
  const job = store.requestAbort(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "job_not_found" });
    return;
  }
  res.json({ job });
});

app.get("/v1/admin/state", requireApiKey(gatewayToken), (_req, res) => {
  res.json({ admin: AdminStateSchema.parse(store.getAdminState()) });
});

app.post("/v1/admin/pause", requireApiKey(gatewayToken), (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    const admin = store.setPaused(true, body.reason ?? "Paused by owner");
    res.json({ admin: AdminStateSchema.parse(admin) });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/admin/resume", requireApiKey(gatewayToken), (_req, res) => {
  const admin = store.setPaused(false);
  res.json({ admin: AdminStateSchema.parse(admin) });
});

app.post("/v1/workers/claim", requireApiKey(workerToken), (req, res, next) => {
  try {
    const parsed = ClaimJobRequestSchema.parse(req.body);
    const job = store.claimNextQueuedJob(parsed.workerId) ?? null;
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/workers/:jobId/events", requireApiKey(workerToken), (req, res, next) => {
  try {
    const parsed = WorkerEventRequestSchema.parse(req.body);
    const job = store.appendWorkerEvent(req.params.jobId, parsed.event);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.status(202).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/workers/:jobId/heartbeat", requireApiKey(workerToken), (req, res) => {
  const abortRequested = store.getAbortRequested(req.params.jobId);
  res.json(WorkerHeartbeatResponseSchema.parse({ abortRequested }));
});

app.post("/v1/workers/:jobId/complete", requireApiKey(workerToken), (req, res, next) => {
  try {
    const parsed = WorkerCompleteRequestSchema.parse(req.body);
    const job = store.completeJob(req.params.jobId, parsed.resultText);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/workers/:jobId/fail", requireApiKey(workerToken), (req, res, next) => {
  try {
    const parsed = WorkerFailRequestSchema.parse(req.body);
    const job = store.failJob(req.params.jobId, parsed.error);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/workers/:jobId/aborted", requireApiKey(workerToken), (req, res, next) => {
  try {
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    const job = store.markAborted(req.params.jobId, body.reason);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json({ job });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "invalid_request", details: error.flatten() });
    return;
  }

  const message = error instanceof Error ? error.message : "unexpected_error";
  res.status(500).json({ error: "internal_error", message });
});

app.listen(port, host, () => {
  console.log(`[orchestrator] listening on ${host}:${port}`);
  console.log(`[orchestrator] state file: ${statePath}`);
});

function requireApiKey(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const headerToken = req.header("x-api-key");
    const authHeader = req.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const provided = headerToken ?? bearerToken;

    if (!provided || provided !== expected) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    next();
  };
}

function requireSecret(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required secret ${name}`);
  }

  if (value.length < 16) {
    throw new Error(`${name} must be at least 16 characters`);
  }

  return value;
}
