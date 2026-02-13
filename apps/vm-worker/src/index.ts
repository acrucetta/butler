import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Job, JobEvent, JobEventType } from "@pi-self/contracts";
import { OrchestratorClient } from "./orchestrator-client.js";
import { PiRpcSessionPool } from "./pi-rpc-session.js";

const orchestratorBaseUrl = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8787";
const workerToken = requireSecret("ORCH_WORKER_TOKEN", process.env.ORCH_WORKER_TOKEN);
const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const pollMs = Number(process.env.WORKER_POLL_MS ?? "2000");
const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS ?? "2000");
const executionMode = parseExecutionMode(process.env.PI_EXEC_MODE ?? "mock");
const piBinary = process.env.PI_BINARY ?? "pi";
const piProvider = process.env.PI_PROVIDER;
const piModel = process.env.PI_MODEL;
const piCwd = resolve(process.env.PI_WORKSPACE ?? ".data/worker/workspace");
const piSessionRoot = resolve(process.env.PI_SESSION_ROOT ?? ".data/worker/sessions");

mkdirSync(piCwd, { recursive: true });
mkdirSync(piSessionRoot, { recursive: true });

const orchestrator = new OrchestratorClient(orchestratorBaseUrl, workerToken);
const sessionPool = new PiRpcSessionPool({
  piBinary,
  cwd: piCwd,
  sessionRoot: piSessionRoot,
  provider: piProvider,
  model: piModel
});

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
  });
}

await run();

async function run(): Promise<void> {
  console.log(`[worker] started workerId=${workerId} mode=${executionMode} orchestrator=${orchestratorBaseUrl}`);
  if (executionMode === "rpc") {
    console.log(`[worker] rpc mode enabled with PI_BINARY=${piBinary}`);
  }

  while (!shuttingDown) {
    try {
      const job = await orchestrator.claimJob(workerId);
      if (!job) {
        await sleep(pollMs);
        continue;
      }

      await runJob(job);
    } catch (error) {
      console.error(`[worker] loop error: ${formatError(error)}`);
      await sleep(pollMs);
    }
  }

  await sessionPool.shutdown();
  console.log("[worker] shutdown complete");
}

async function runJob(job: Job): Promise<void> {
  console.log(`[worker] running job=${job.id} kind=${job.kind} session=${job.sessionKey}`);
  await postEvent(job.id, "log", "Worker started execution");

  if (executionMode === "mock") {
    await runMockJob(job);
    return;
  }

  const session = sessionPool.getSession(job.sessionKey);

  let abortRequested = false;
  let heartbeatActive = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatActive) {
      return;
    }

    heartbeatActive = true;
    void (async () => {
      try {
        const shouldAbort = await orchestrator.heartbeat(job.id);
        if (shouldAbort && !abortRequested) {
          abortRequested = true;
          await postEvent(job.id, "log", "Abort requested by orchestrator");
          await session.abort();
        }
      } catch (error) {
        console.error(`[worker] heartbeat error job=${job.id}: ${formatError(error)}`);
      } finally {
        heartbeatActive = false;
      }
    })();
  }, heartbeatMs);

  let deltaBuffer = "";
  let fullText = "";
  let deltaSending = false;
  const flushDelta = async (): Promise<void> => {
    if (!deltaBuffer || deltaSending) {
      return;
    }

    deltaSending = true;
    const chunk = deltaBuffer;
    deltaBuffer = "";

    try {
      await postEvent(job.id, "agent_text_delta", undefined, { delta: chunk });
    } finally {
      deltaSending = false;
    }
  };

  const deltaTimer = setInterval(() => {
    void flushDelta();
  }, 1200);

  try {
    const result = await session.prompt(job.prompt, {
      onTextDelta(delta) {
        fullText += delta;
        deltaBuffer += delta;
      },
      onToolStart(toolName) {
        void postEvent(job.id, "tool_start", `Tool started: ${toolName}`, { toolName });
      },
      onToolEnd(toolName) {
        void postEvent(job.id, "tool_end", `Tool finished: ${toolName}`, { toolName });
      },
      onLog(message) {
        void postEvent(job.id, "log", message);
      }
    });

    await flushDelta();

    if (abortRequested) {
      await orchestrator.aborted(job.id, "Abort requested by user");
      console.log(`[worker] job aborted after execution job=${job.id}`);
      return;
    }

    const finalResult = result.trim().length > 0 ? result : fullText;
    await orchestrator.complete(job.id, finalResult);
    console.log(`[worker] job complete job=${job.id}`);
  } catch (error) {
    if (abortRequested) {
      await orchestrator.aborted(job.id, "Abort requested by user");
      console.log(`[worker] job aborted job=${job.id}`);
      return;
    }

    const message = formatError(error);
    await orchestrator.fail(job.id, message);
    console.error(`[worker] job failed job=${job.id}: ${message}`);
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(deltaTimer);
  }
}

async function runMockJob(job: Job): Promise<void> {
  const steps = [
    "Booting sandbox session",
    "Planning task",
    "Running mock operations",
    "Collecting output"
  ];

  for (const step of steps) {
    const shouldAbort = await orchestrator.heartbeat(job.id);
    if (shouldAbort) {
      await orchestrator.aborted(job.id, "Abort requested while in mock mode");
      console.log(`[worker] mock aborted job=${job.id}`);
      return;
    }

    await postEvent(job.id, "log", step);
    await sleep(900);
  }

  const result = [
    "[mock-worker] This is a simulated Pi response.",
    "",
    `Prompt: ${job.prompt}`,
    `Session: ${job.sessionKey}`,
    `Timestamp: ${new Date().toISOString()}`
  ].join("\n");

  await orchestrator.complete(job.id, result);
  console.log(`[worker] mock complete job=${job.id}`);
}

async function postEvent(
  jobId: string,
  type: JobEventType,
  message?: string,
  data?: Record<string, unknown>
): Promise<void> {
  const event: JobEvent = {
    type,
    ts: new Date().toISOString(),
    message,
    data
  };

  await orchestrator.postEvent(jobId, event);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function parseExecutionMode(value: string): "mock" | "rpc" {
  if (value === "mock" || value === "rpc") {
    return value;
  }
  throw new Error(`Invalid PI_EXEC_MODE '${value}'. Expected 'mock' or 'rpc'.`);
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
