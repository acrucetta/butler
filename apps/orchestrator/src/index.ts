import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { registerHttpRoutes } from "./http-routes.js";
import { MemoryService } from "./memory-service.js";
import { MemorySemanticIndex } from "./memory-semantic-index.js";
import { ProactiveRuntime } from "./proactive-runtime.js";
import { OrchestratorStore } from "./store.js";
import { loadJsonWithLegacyFallback } from "./config-paths.js";

const port = Number(process.env.ORCH_PORT ?? "8787");
const host = process.env.ORCH_HOST ?? "127.0.0.1";
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceRoot = resolve(process.env.BUTLER_WORKSPACE_ROOT ?? moduleRoot);
const statePath = resolve(workspaceRoot, process.env.ORCH_STATE_FILE ?? ".data/orchestrator/state.json");
const proactiveConfigPath = resolve(
  workspaceRoot,
  process.env.ORCH_PROACTIVE_CONFIG_FILE ?? ".data/orchestrator/proactive-runtime.json"
);
const legacyProactiveConfigPath = resolve(workspaceRoot, "apps/orchestrator/.data/orchestrator/proactive-runtime.json");
const memoryRoot = resolve(workspaceRoot, process.env.ORCH_MEMORY_ROOT ?? ".");
const memoryLedgerPath = resolve(workspaceRoot, process.env.ORCH_MEMORY_LEDGER_FILE ?? ".data/orchestrator/memory-ledger.jsonl");
const memoryIndexPath = resolve(workspaceRoot, process.env.ORCH_MEMORY_INDEX_FILE ?? ".data/orchestrator/memory-index.json");
const upStatusPath = resolve(workspaceRoot, process.env.BUTLER_UP_STATUS_FILE ?? ".data/runtime/up-status.json");
const ownerChatId = process.env.ORCH_OWNER_CHAT_ID ?? "";
const gatewayToken = requireSecret("ORCH_GATEWAY_TOKEN", process.env.ORCH_GATEWAY_TOKEN);
const workerToken = requireSecret("ORCH_WORKER_TOKEN", process.env.ORCH_WORKER_TOKEN);
const staleJobReaperEnabled = parseBoolean(process.env.ORCH_STALE_JOB_REAPER_ENABLED, true);
const staleJobIdleMs = parseIntWithFallback(process.env.ORCH_STALE_JOB_IDLE_MS, 5 * 60_000);
const staleJobReaperTickMs = parseIntWithFallback(process.env.ORCH_STALE_JOB_REAPER_TICK_MS, 30_000);

mkdirSync(dirname(statePath), { recursive: true });
mkdirSync(dirname(proactiveConfigPath), { recursive: true });
mkdirSync(dirname(memoryLedgerPath), { recursive: true });
mkdirSync(dirname(memoryIndexPath), { recursive: true });
const store = new OrchestratorStore(statePath);
const memory = new MemoryService(memoryRoot, memoryLedgerPath);
const memorySemantic = new MemorySemanticIndex({
  memoryRoot,
  indexFile: memoryIndexPath
});
const proactive = new ProactiveRuntime(
  store,
  loadProactiveConfig(proactiveConfigPath),
  { onConfigChange: (nextConfig) => persistProactiveConfig(proactiveConfigPath, nextConfig) }
);
proactive.start();
let staleJobReaperTimer: NodeJS.Timeout | null = null;
if (staleJobReaperEnabled) {
  const runStaleReaper = () => {
    const reaped = store.reapStaleActiveJobs(staleJobIdleMs);
    if (reaped.length > 0) {
      console.warn(
        `[orchestrator] stale-job reaper handled ${reaped.length} job(s): ${reaped.map((job) => `${job.id}:${job.status}`).join(", ")}`
      );
    }
  };

  runStaleReaper();
  staleJobReaperTimer = setInterval(runStaleReaper, staleJobReaperTickMs);
}
const app = express();

app.use(express.json({ limit: "1mb" }));
app.disable("x-powered-by");
app.use((req, _res, next) => {
  req.socket.setTimeout(60_000);
  next();
});

registerHttpRoutes({
  app,
  store,
  proactive,
  memory,
  memorySemantic,
  gatewayToken,
  workerToken,
  upStatusPath
});

app.listen(port, host, () => {
  console.log(`[orchestrator] listening on ${host}:${port}`);
  console.log(`[orchestrator] state file: ${statePath}`);
  console.log(`[orchestrator] proactive config: ${proactiveConfigPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    proactive.stop();
    if (staleJobReaperTimer) {
      clearInterval(staleJobReaperTimer);
      staleJobReaperTimer = null;
    }
  });
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseIntWithFallback(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
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

function loadProactiveConfig(filePath: string): unknown {
  const config = loadJsonWithLegacyFallback(filePath, legacyProactiveConfigPath) as Record<string, unknown>;

  if (ownerChatId) {
    const heartbeats = Array.isArray(config.heartbeatRules) ? config.heartbeatRules : [];
    const alreadyExists = heartbeats.some(
      (r: unknown) => typeof r === "object" && r !== null && (r as Record<string, unknown>).id === "system:owner-checkin"
    );
    if (!alreadyExists) {
      heartbeats.push({
        id: "system:owner-checkin",
        everySeconds: 1800,
        prompt: "Check in: review recent activity, pending tasks, and anything that needs attention.",
        delivery: { mode: "announce" },
        target: {
          kind: "task",
          chatId: ownerChatId,
          requesterId: ownerChatId,
          sessionKey: `proactive:heartbeat:system:owner-checkin`
        }
      });
      config.heartbeatRules = heartbeats;
    }
  }

  return config;
}

function persistProactiveConfig(filePath: string, config: unknown): void {
  const payload = JSON.stringify(config, null, 2);
  writeFileSync(filePath, `${payload}\n`, "utf8");
}
