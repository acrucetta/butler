import { ProactiveCronRuleSchema, ProactiveHeartbeatRuleSchema } from "@pi-self/contracts";
import { z } from "zod";
import type { MemorySemanticIndex } from "./memory-semantic-index.js";
import type { MemoryService } from "./memory-service.js";
import type { ProactiveRuntime } from "./proactive-runtime.js";
import type { OrchestratorStore } from "./store.js";

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export class ToolError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: Record<string, unknown>
  ) {
    super(String(body.error ?? "tool_error"));
  }
}

export interface BuildToolRegistryInput {
  proactive: ProactiveRuntime;
  store: OrchestratorStore;
  memory: MemoryService;
  memorySemantic: MemorySemanticIndex;
}

const idArg = (args: Record<string, unknown>) =>
  z.object({ id: z.string().min(1).max(120) }).parse(args);

export function buildToolRegistry(input: BuildToolRegistryInput): Record<string, ToolHandler> {
  const { proactive, store, memory, memorySemantic } = input;

  return {
    "cron.list": async () => ({ rules: proactive.getConfigSummary().cronRules }),

    "cron.add": async (args) => ({ rule: proactive.upsertCronRule(ProactiveCronRuleSchema.parse(args)) }),
    "cron.update": async (args) => ({ rule: proactive.upsertCronRule(ProactiveCronRuleSchema.parse(args)) }),

    "cron.remove": async (args) => {
      if (!proactive.deleteCronRule(idArg(args).id)) throw new ToolError(404, { error: "rule_not_found" });
      return { removed: true };
    },

    "cron.run": async (args) => {
      const result = proactive.triggerCronNow(idArg(args).id);
      if (result.status === "not_found") throw new ToolError(404, { error: "rule_not_found" });
      return result;
    },

    "heartbeat.list": async () => ({ rules: proactive.getConfigSummary().heartbeatRules }),

    "heartbeat.add": async (args) => ({ rule: proactive.upsertHeartbeatRule(ProactiveHeartbeatRuleSchema.parse(args)) }),
    "heartbeat.update": async (args) => ({ rule: proactive.upsertHeartbeatRule(ProactiveHeartbeatRuleSchema.parse(args)) }),

    "heartbeat.remove": async (args) => {
      if (!proactive.deleteHeartbeatRule(idArg(args).id)) throw new ToolError(404, { error: "rule_not_found" });
      return { removed: true };
    },

    "heartbeat.run": async (args) => {
      const result = proactive.triggerHeartbeatNow(idArg(args).id);
      if (result.status === "not_found") throw new ToolError(404, { error: "rule_not_found" });
      return result;
    },

    "heartbeat.reset-dedup": async (args) => {
      const body = z.object({ triggerKey: z.string().min(1).max(240).optional() }).parse(args);
      const cleared = store.clearLastDelivered(body.triggerKey);
      return { cleared };
    },

    "proactive.runs": async (args) => {
      const body = z.object({
        limit: z.number().int().min(1).max(200).default(50),
        triggerKey: z.string().min(1).max(240).optional()
      }).parse(args);
      return { runs: store.listProactiveRuns(body.limit, body.triggerKey) };
    },

    "memory.search": async (args) => {
      const body = z.object({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(50).default(10)
      }).parse(args);
      return { hits: await memorySemantic.search(body.query, body.limit) };
    },

    "memory.store": async (args) => {
      const body = z.object({
        text: z.string().min(1).max(2_000),
        scope: z.enum(["daily", "durable"]).default("daily")
      }).parse(args);
      const stored = memory.store(body.text, body.scope);
      await memorySemantic.rebuild();
      return stored;
    },

    "memory.ledger": async (args) => {
      const body = z.object({ limit: z.number().int().min(1).max(200).default(50) }).parse(args);
      return { entries: memory.ledger(body.limit) };
    },

    "memory.index": async () => await memorySemantic.rebuild(),

    "memory.status": async () => memorySemantic.status()
  };
}
