import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { Job, JobEvent, JobEventType } from "@pi-self/contracts";
import { ModelRoutingRuntime } from "./model-routing.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import { ToolPolicyRuntime } from "./tool-policy.js";

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
const piAppendSystemPrompt = process.env.PI_APPEND_SYSTEM_PROMPT ?? defaultMemoryPrompt();
const modelRoutingConfigFile = resolve(process.env.PI_MODEL_ROUTING_FILE ?? ".data/worker/model-routing.json");
const modelRoutingConfigRequired = Boolean(process.env.PI_MODEL_ROUTING_FILE);
const toolPolicyConfigFile = resolve(process.env.PI_TOOL_POLICY_FILE ?? ".data/worker/tool-policy.json");
const toolPolicyConfigRequired = Boolean(process.env.PI_TOOL_POLICY_FILE);
const mcpCliBinDir = resolve(process.env.BUTLER_MCP_BIN_DIR ?? ".data/mcp/bin");

mkdirSync(piCwd, { recursive: true });
mkdirSync(piSessionRoot, { recursive: true });
mkdirSync(mcpCliBinDir, { recursive: true });
bootstrapWorkspaceMemory(piCwd);
process.env.PATH = prependPathEntry(mcpCliBinDir, process.env.PATH);

const orchestrator = new OrchestratorClient(orchestratorBaseUrl, workerToken);
const modelRouting = new ModelRoutingRuntime({
  piBinary,
  cwd: piCwd,
  sessionRoot: piSessionRoot,
  appendSystemPrompt: piAppendSystemPrompt,
  defaultProvider: piProvider,
  defaultModel: piModel,
  configFilePath: modelRoutingConfigFile,
  requireConfigFile: modelRoutingConfigRequired,
  logger: console
});
const toolPolicy = new ToolPolicyRuntime({
  configFilePath: toolPolicyConfigFile,
  requireConfigFile: toolPolicyConfigRequired,
  logger: console
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
    console.log(`[worker] rpc workspace=${piCwd}`);
    console.log(`[worker] rpc sessions=${piSessionRoot}`);
    console.log(`[worker] model routing config=${modelRoutingConfigFile} source=${modelRouting.getSourceLabel()}`);
    console.log(`[worker] tool policy config=${toolPolicyConfigFile} source=${toolPolicy.getSourceLabel()}`);
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

  await modelRouting.shutdown();
  console.log("[worker] shutdown complete");
}

async function runJob(job: Job): Promise<void> {
  console.log(`[worker] running job=${job.id} kind=${job.kind} session=${job.sessionKey}`);
  await postEvent(job.id, "log", "Worker started execution");

  if (executionMode === "mock") {
    await runMockJob(job);
    return;
  }

  let abortRequested = false;
  let activeSession: { abort: () => Promise<void> } | null = null;
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
          if (activeSession) {
            await activeSession.abort();
          }
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
    const preparedPrompt = buildPromptWithWorkspaceContext(job.prompt, piCwd);
    const plan = modelRouting.buildPlan(job);
    await postEvent(
      job.id,
      "log",
      `Model route: ${plan.profiles.map((profile) => profile.id).join(" -> ")} (maxAttempts=${plan.maxAttempts})`
    );

    let finalResult = "";
    let completed = false;

    for (let attempt = 0; attempt < plan.maxAttempts; attempt += 1) {
      const profile = plan.profiles[attempt];
      if (!profile) {
        break;
      }

      let attemptHadOutput = false;
      let attemptHadToolActivity = false;

      await postEvent(
        job.id,
        "log",
        `Model attempt ${attempt + 1}/${plan.maxAttempts}: ${profile.id} (${profile.provider ?? "default"}/${profile.model ?? "default"})`
      );
      const policyContext = toolPolicy.resolveContext(job.kind, profile.id);
      const allowSummary = policyContext.allow === null ? "*" : policyContext.allow.join(", ");
      const denySummary = policyContext.deny.length > 0 ? policyContext.deny.join(", ") : "(none)";
      await postEvent(
        job.id,
        "log",
        `Tool policy for attempt: allow=[${allowSummary}] deny=[${denySummary}]`
      );

      const session = modelRouting.getSession(profile.id, job.sessionKey);
      activeSession = session;

      try {
        let policyViolationMessage: string | null = null;
        let policyAbortSent = false;
        const blockedTools = new Set<string>();

        const result = await session.prompt(preparedPrompt, {
          onTextDelta(delta) {
            attemptHadOutput = true;
            fullText += delta;
            deltaBuffer += delta;
          },
          onToolStart(toolName) {
            attemptHadToolActivity = true;

            const decision = policyContext.evaluateTool(toolName);
            if (!decision.allowed) {
              blockedTools.add(toolName);
              policyViolationMessage = `Tool policy denied '${toolName}' (reason=${decision.reason}${decision.matchedDenyPattern ? ` pattern=${decision.matchedDenyPattern}` : ""})`;
              void postEvent(job.id, "log", policyViolationMessage);
              if (!policyAbortSent && activeSession) {
                policyAbortSent = true;
                void activeSession.abort();
              }
              return;
            }

            void postEvent(job.id, "tool_start", `Tool started: ${toolName}`, { toolName });
          },
          onToolEnd(toolName) {
            attemptHadToolActivity = true;
            if (blockedTools.has(toolName)) {
              return;
            }
            void postEvent(job.id, "tool_end", `Tool finished: ${toolName}`, { toolName });
          },
          onLog(message) {
            void postEvent(job.id, "log", message);
          }
        });

        if (policyViolationMessage) {
          throw new Error(policyViolationMessage);
        }

        modelRouting.markSuccess(profile.id);
        await flushDelta();
        finalResult = result.trim().length > 0 ? result : fullText;
        completed = true;
        break;
      } catch (error) {
        const message = formatError(error);
        const evaluation = modelRouting.evaluateFallback(profile.id, {
          abortRequested,
          attemptHadOutput,
          attemptHadToolActivity,
          errorMessage: message
        });

        await postEvent(
          job.id,
          "log",
          `Model attempt failed profile=${profile.id} fallback=${String(evaluation.fallback)} reason=${evaluation.reason}: ${message}`
        );

        const hasNextAttempt = attempt + 1 < plan.maxAttempts;
        if (!evaluation.fallback || !hasNextAttempt) {
          throw error;
        }
      } finally {
        activeSession = null;
      }
    }

    if (!completed) {
      throw new Error("Model route exhausted without successful completion");
    }

    if (abortRequested) {
      await orchestrator.aborted(job.id, "Abort requested by user");
      console.log(`[worker] job aborted after execution job=${job.id}`);
      return;
    }

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

function prependPathEntry(entry: string, currentPath: string | undefined): string {
  const values = (currentPath ?? "").split(delimiter).filter((part) => part.length > 0);
  if (values.includes(entry)) {
    return values.join(delimiter);
  }
  return [entry, ...values].join(delimiter);
}

function bootstrapWorkspaceMemory(workspaceRoot: string): void {
  const memoryDir = resolve(workspaceRoot, "memory");
  const memoryFile = resolve(workspaceRoot, "MEMORY.md");
  const todayFile = resolve(memoryDir, `${formatLocalDate(new Date())}.md`);

  mkdirSync(memoryDir, { recursive: true });

  writeIfMissing(
    memoryFile,
    [
      "# MEMORY",
      "",
      "Long-term durable facts and user preferences for this agent.",
      "",
      "- Keep entries short and factual.",
      "- Update this when a user explicitly asks to remember something important.",
      ""
    ].join("\n")
  );

  writeIfMissing(
    todayFile,
    [
      `# ${formatLocalDate(new Date())}`,
      "",
      "Daily notes for short-lived context and handoff breadcrumbs.",
      ""
    ].join("\n")
  );
}

function writeIfMissing(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    return;
  }
  writeFileSync(filePath, content, "utf8");
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultMemoryPrompt(): string {
  return [
    "OpenClaw-style memory policy:",
    "- Treat workspace Markdown files as source of truth.",
    "- Load personality from SOUL.md.",
    "- Use MEMORY.md for durable user preferences and stable facts.",
    "- Use memory/YYYY-MM-DD.md for short-lived daily notes.",
    "- If user says to remember something, write it to MEMORY.md or today's memory file.",
    "- Keep memory concise and accurate; do not invent facts.",
    "- Continue using the session transcript normally, but persist durable facts to files.",
    "- Telegram formatting note: when using MarkdownV2, use *bold*, _italic_, __underline__, ~strikethrough~, and backticks for code.",
    "- Do not use single-asterisk italics (*like this*) for Telegram; use underscores (_like this_) for italics.",
    "- Telegram MarkdownV2 does not support native tables or horizontal rules; prefer compact lists, or render tables as fenced code blocks."
  ].join("\n");
}

function buildPromptWithWorkspaceContext(userPrompt: string, workspaceRoot: string): string {
  const soulPath = resolve(workspaceRoot, "SOUL.md");
  const memoryPath = resolve(workspaceRoot, "MEMORY.md");
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const dailyFiles = [today, yesterday].map((value) =>
    resolve(workspaceRoot, "memory", `${formatLocalDate(value)}.md`)
  );

  const sections: string[] = [];
  const soul = readTextIfExists(soulPath, 5_000);
  if (soul) {
    sections.push(`## SOUL.md\n${soul}`);
  }

  const durable = readTextIfExists(memoryPath, 5_000);
  if (durable) {
    sections.push(`## MEMORY.md\n${durable}`);
  }

  for (const filePath of dailyFiles) {
    const daily = readTextIfExists(filePath, 3_000);
    if (daily) {
      const name = filePath.split("/").at(-1) ?? "memory.md";
      sections.push(`## memory/${name}\n${daily}`);
    }
  }

  if (sections.length === 0) {
    return userPrompt;
  }

  return [
    "Workspace context snapshot (OpenClaw-style personality and memory).",
    "Treat this as active context. Do not repeat it verbatim to the user.",
    sections.join("\n\n"),
    "## User request",
    userPrompt
  ].join("\n\n");
}

function readTextIfExists(filePath: string, maxChars: number): string {
  if (!existsSync(filePath)) {
    return "";
  }

  const content = readFileSync(filePath, "utf8").trim();
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(content.length - maxChars)}\n\n[truncated to latest ${maxChars} chars]`;
}
