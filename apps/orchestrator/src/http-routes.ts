import { existsSync, readFileSync } from "node:fs";
import {
  AdminStateSchema,
  ClaimJobRequestSchema,
  JobCreateRequestSchema,
  JobEventsResponseSchema,
  JobSchema,
  ProactiveCronRuleSchema,
  ProactiveHeartbeatRuleSchema,
  WorkerCompleteRequestSchema,
  WorkerEventRequestSchema,
  WorkerFailRequestSchema,
  WorkerHeartbeatResponseSchema
} from "@pi-self/contracts";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { MemorySemanticIndex } from "./memory-semantic-index.js";
import type { MemoryService } from "./memory-service.js";
import type { ProactiveRuntime } from "./proactive-runtime.js";
import type { OrchestratorStore } from "./store.js";
import { ToolError, buildToolRegistry } from "./tools-registry.js";

interface RegisterHttpRoutesInput {
  app: Express;
  store: OrchestratorStore;
  proactive: ProactiveRuntime;
  memory: MemoryService;
  memorySemantic: MemorySemanticIndex;
  gatewayToken: string;
  workerToken: string;
  upStatusPath: string;
}

const ToolsInvokeRequestSchema = z.object({
  tool: z.string().min(1).max(120),
  arguments: z.record(z.unknown()).default({})
});

export function registerHttpRoutes(input: RegisterHttpRoutesInput): void {
  const { app, store, proactive, memory, memorySemantic, gatewayToken, workerToken, upStatusPath } = input;

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

  app.get("/v1/admin/services", requireApiKey(gatewayToken), (_req, res) => {
    const status = store.getServiceStatus() ?? loadUpStatus(upStatusPath);
    res.json({ services: status });
  });

  app.post("/v1/admin/services/state", requireApiKey(workerToken), (req, res, next) => {
    try {
      const body = z.object({ services: z.unknown() }).parse(req.body ?? {});
      store.setServiceStatus(body.services);
      res.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/proactive/state", requireApiKey(gatewayToken), (_req, res) => {
    res.json({ proactive: proactive.getState() });
  });

  app.get("/v1/proactive/config", requireApiKey(gatewayToken), (_req, res) => {
    res.json({ config: proactive.getConfigSummary() });
  });

  app.get("/v1/proactive/runs", requireApiKey(gatewayToken), (req, res) => {
    const limitRaw = Number(req.query.limit ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;
    const triggerKey = typeof req.query.triggerKey === "string" ? req.query.triggerKey : undefined;
    const runs = store.listProactiveRuns(limit, triggerKey);
    res.json({ runs });
  });

  app.post("/v1/proactive/rules/heartbeat", requireApiKey(gatewayToken), (req, res, next) => {
    try {
      const parsed = ProactiveHeartbeatRuleSchema.parse(req.body);
      const rule = proactive.upsertHeartbeatRule(parsed);
      res.json({ rule });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/v1/proactive/rules/heartbeat/:id", requireApiKey(gatewayToken), (req, res) => {
    const removed = proactive.deleteHeartbeatRule(req.params.id);
    if (!removed) {
      res.status(404).json({ error: "rule_not_found" });
      return;
    }

    res.json({ ok: true });
  });

  app.post("/v1/proactive/rules/cron", requireApiKey(gatewayToken), (req, res, next) => {
    try {
      const parsed = ProactiveCronRuleSchema.parse(req.body);
      const rule = proactive.upsertCronRule(parsed);
      res.json({ rule });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/v1/proactive/rules/cron/:id", requireApiKey(gatewayToken), (req, res) => {
    const removed = proactive.deleteCronRule(req.params.id);
    if (!removed) {
      res.status(404).json({ error: "rule_not_found" });
      return;
    }

    res.json({ ok: true });
  });

  app.get("/v1/proactive/deliveries/pending", requireApiKey(gatewayToken), (req, res) => {
    const limitRaw = Number(req.query.limit ?? "20");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 20;
    const jobs = store.listPendingProactiveDeliveries(limit);
    res.json({ jobs });
  });

  app.post("/v1/proactive/deliveries/:jobId/ack", requireApiKey(gatewayToken), (req, res, next) => {
    try {
      const body = z.object({ receipt: z.string().min(1).max(2_000) }).parse(req.body ?? {});
      const job = store.markProactiveDelivery(req.params.jobId, body.receipt);
      if (!job) {
        res.status(404).json({ error: "job_not_found" });
        return;
      }

      res.json({ job });
    } catch (error) {
      next(error);
    }
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
    store.touchJobHeartbeat(req.params.jobId);
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

  app.post("/v1/proactive/webhooks/:webhookId", (req, res) => {
    const providedSecret = req.header("x-webhook-secret");
    const result = proactive.triggerWebhook(req.params.webhookId, providedSecret, req.body);

    if (result.status === "not_found") {
      res.status(404).json({ error: "webhook_not_found" });
      return;
    }

    if (result.status === "unauthorized") {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    if (result.status === "duplicate_active_job") {
      res.status(202).json({ ok: true, status: result.status, jobId: null });
      return;
    }

    if (result.status === "backoff_blocked") {
      res.status(202).json({ ok: true, status: result.status, jobId: null });
      return;
    }

    res.status(202).json({ ok: true, status: result.status, jobId: result.jobId ?? null });
  });

  app.get("/v1/tools", requireApiKey(gatewayToken), (_req, res) => {
    res.json({
      tools: [
        { name: "cron.list", description: "List proactive cron rules." },
        { name: "cron.add", description: "Create a proactive cron rule (supports cron|at|everySeconds)." },
        { name: "cron.update", description: "Update a proactive cron rule (supports cron|at|everySeconds)." },
        { name: "cron.remove", description: "Delete a proactive cron rule by id." },
        { name: "cron.run", description: "Trigger an existing proactive cron rule immediately." },
        { name: "heartbeat.list", description: "List proactive heartbeat rules." },
        { name: "heartbeat.add", description: "Create a proactive heartbeat rule." },
        { name: "heartbeat.update", description: "Update a proactive heartbeat rule." },
        { name: "heartbeat.remove", description: "Delete a proactive heartbeat rule by id." },
        { name: "heartbeat.run", description: "Trigger an existing proactive heartbeat rule immediately." },
        { name: "heartbeat.reset-dedup", description: "Clear cached heartbeat text so the next heartbeat delivers even if identical. Pass triggerKey to clear one, or omit to clear all." },
        { name: "proactive.runs", description: "List recent proactive run ledger entries." },
        { name: "memory.search", description: "Semantic search across memory files (local vector index)." },
        { name: "memory.store", description: "Store a memory entry in daily or durable scope." },
        { name: "memory.ledger", description: "List recent memory write ledger entries." },
        { name: "memory.index", description: "Rebuild semantic memory index." },
        { name: "memory.status", description: "Get semantic memory index status." }
      ]
    });
  });

  // ── Tool dispatch table ──────────────────────────────────────────────
  const toolHandlers = buildToolRegistry({ proactive, store, memory, memorySemantic });

  app.post("/v1/tools/invoke", requireApiKey(gatewayToken), async (req, res, next) => {
    try {
      const parsed = ToolsInvokeRequestSchema.parse(req.body ?? {});
      const handler = toolHandlers[parsed.tool];
      if (!handler) {
        res.status(400).json({ error: "unknown_tool", tool: parsed.tool });
        return;
      }
      const result = await handler(parsed.arguments);
      res.json({ ok: true, result });
    } catch (error) {
      if (error instanceof ToolError) {
        res.status(error.statusCode).json(error.body);
        return;
      }
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
}

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

function loadUpStatus(filePath: string): unknown {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return { error: "invalid_status_file", path: filePath };
  }
}
