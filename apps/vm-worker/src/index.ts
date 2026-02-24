import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { Job, JobEvent, JobEventType } from "@pi-self/contracts";
import { ModelRoutingRuntime, type ExecutionMode } from "./model-routing.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import type { PiSession } from "./pi-session.js";
import { parseSkillsMode, resolveSkillsContext } from "./skills-runtime.js";
import { ToolPolicyRuntime } from "./tool-policy.js";

const orchestratorBaseUrl = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8787";
const workerToken = requireSecret("ORCH_WORKER_TOKEN", process.env.ORCH_WORKER_TOKEN);
const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const pollMs = Number(process.env.WORKER_POLL_MS ?? "2000");
const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS ?? "2000");
const executionMode = parseExecutionMode(process.env.PI_EXEC_MODE ?? "mock");
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
const skillsConfigFile = resolve(process.env.PI_SKILLS_CONFIG_FILE ?? ".data/skills/config.json");
const skillsModeOverride = parseSkillsMode(process.env.PI_SKILLS_MODE);
const skillsContextWindowOverride = parsePositiveInt(process.env.PI_SKILLS_CONTEXT_WINDOW);
const skillsMaxCharsOverride = parsePositiveInt(process.env.PI_SKILLS_MAX_CHARS);
const skillsDir = process.env.PI_SKILLS_DIR ? resolve(process.env.PI_SKILLS_DIR) : undefined;
const historyLimit = parsePositiveInt(process.env.PI_HISTORY_LIMIT) ?? 30;

mkdirSync(piCwd, { recursive: true });
mkdirSync(piSessionRoot, { recursive: true });
mkdirSync(mcpCliBinDir, { recursive: true });
bootstrapWorkspaceMemory(piCwd);
process.env.PATH = prependPathEntry(mcpCliBinDir, process.env.PATH);

const orchestrator = new OrchestratorClient(orchestratorBaseUrl, workerToken);
const modelRouting = new ModelRoutingRuntime({
  executionMode,
  cwd: piCwd,
  sessionRoot: piSessionRoot,
  appendSystemPrompt: piAppendSystemPrompt,
  historyLimit,
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

/** Active sessions by sessionKey — enables steer() for messages arriving mid-run. */
const activeRuns = new Map<string, PiSession>();

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
  });
}

await run();

async function run(): Promise<void> {
  console.log(`[worker] started workerId=${workerId} mode=${executionMode} orchestrator=${orchestratorBaseUrl}`);
  if (executionMode === "embedded") {
    console.log(`[worker] embedded mode enabled`);
    console.log(`[worker] embedded workspace=${piCwd}`);
    console.log(`[worker] embedded sessions=${piSessionRoot}`);
    console.log(`[worker] model routing config=${modelRoutingConfigFile} source=${modelRouting.getSourceLabel()}`);
    console.log(`[worker] tool policy config=${toolPolicyConfigFile} source=${toolPolicy.getSourceLabel()}`);
    console.log(
      `[worker] skills config=${skillsConfigFile} mode=${skillsModeOverride ?? "config"} contextWindow=${skillsContextWindowOverride ?? "config"}`
    );
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

  // If this session already has an active run, steer the message in instead
  // of starting a separate prompt. This preserves conversational flow when
  // the user sends multiple Telegram messages while the agent is working.
  const existingRun = activeRuns.get(job.sessionKey);
  if (existingRun && existingRun.isStreaming()) {
    console.log(`[worker] steering message into active session=${job.sessionKey} job=${job.id}`);
    await postEvent(job.id, "log", "Steered into active session");
    try {
      await existingRun.steer(job.prompt);
      await orchestrator.complete(job.id, "(steered into active session)");
    } catch (error) {
      await orchestrator.fail(job.id, `Steer failed: ${formatError(error)}`);
    }
    return;
  }

  let abortRequested = false;
  let activeSession: PiSession | null = null;
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
    const skillsContext = resolveSkillsContext({
      userPrompt: job.prompt,
      workspaceRoot: piCwd,
      skillsDir,
      configPath: skillsConfigFile,
      modeOverride: skillsModeOverride ?? undefined,
      contextWindowOverride: skillsContextWindowOverride ?? undefined,
      maxCharsOverride: skillsMaxCharsOverride ?? undefined
    });
    if (skillsContext.selected.length > 0) {
      await postEvent(
        job.id,
        "log",
        `Skills selected (${skillsContext.mode}): ${skillsContext.selected.map((skill) => skill.id).join(", ")}`
      );
    }
    // Workspace context (SOUL.md, MEMORY.md, skills) is now injected into
    // the system prompt via buildSystemPromptContext(). The user prompt is
    // passed through as-is to avoid duplicate context.
    const preparedPrompt = job.prompt;
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
      activeRuns.set(job.sessionKey, session);

      // Refresh the system prompt with latest workspace context (SOUL.md, MEMORY.md, skills).
      // This runs before each prompt so personality/memory changes take effect immediately.
      const systemPrompt = buildSystemPromptContext(piCwd, skillsContext.context);
      if (systemPrompt) {
        session.setSystemPrompt(systemPrompt);
      }

      // Proactively disable denied tools via setActiveToolsByName() so the
      // model never attempts them. This replaces the old abort-on-violation
      // approach — the agent naturally uses alternative tools instead.
      const allTools = session.getAllToolNames();
      if (allTools.length > 0) {
        const allowedTools = allTools.filter((name) => policyContext.evaluateTool(name).allowed);
        if (allowedTools.length < allTools.length) {
          session.setActiveTools(allowedTools);
          const disabledCount = allTools.length - allowedTools.length;
          await postEvent(job.id, "log", `Tool policy disabled ${disabledCount} tool(s) before prompt`);
        }
      }

      try {
        const result = await session.prompt(preparedPrompt, {
          onTextDelta(delta) {
            attemptHadOutput = true;
            fullText += delta;
            deltaBuffer += delta;
          },
          onToolStart(toolName) {
            attemptHadToolActivity = true;
            void postEvent(job.id, "tool_start", `Tool started: ${toolName}`, { toolName });
          },
          onToolEnd(toolName) {
            attemptHadToolActivity = true;
            void postEvent(job.id, "tool_end", `Tool finished: ${toolName}`, { toolName });
          },
          onLog(message) {
            void postEvent(job.id, "log", message);
          }
        });

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

    // If the agent responded with __SILENT__, complete the job without
    // forwarding any text to the user (prevents literal "__SILENT__" in Telegram).
    const isSilent = finalResult.trim() === "__SILENT__";
    await orchestrator.complete(job.id, isSilent ? "" : finalResult);
    console.log(`[worker] job complete job=${job.id}${isSilent ? " (silent)" : ""}`);
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
    activeRuns.delete(job.sessionKey);
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

function parseExecutionMode(value: string): ExecutionMode {
  if (value === "mock" || value === "embedded") {
    return value;
  }
  throw new Error(`Invalid PI_EXEC_MODE '${value}'. Expected 'mock' or 'embedded'.`);
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

function buildSystemPromptContext(workspaceRoot: string, skillsContext: string): string {
  const soulPath = resolve(workspaceRoot, "SOUL.md");
  const memoryPath = resolve(workspaceRoot, "MEMORY.md");
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const dailyFiles = [today, yesterday].map((value) =>
    resolve(workspaceRoot, "memory", `${formatLocalDate(value)}.md`)
  );

  const sections: string[] = [
    "You are a personal assistant running inside Butler.",

    // ── Tooling ──────────────────────────────────────────────────────────
    [
      "## Tooling",
      "Tool availability (filtered by policy):",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      "- read: Read file contents",
      "- write: Create or overwrite files",
      "- edit: Make precise edits to files",
      "- grep: Search file contents for patterns",
      "- find: Find files by glob pattern",
      "- ls: List directory contents",
      "- bash: Run shell commands",
    ].join("\n"),

    // ── Tool Call Style ──────────────────────────────────────────────────
    [
      "## Tool Call Style",
      "Default: do not narrate routine, low-risk tool calls (just call the tool).",
      "Narrate only when it helps: multi-step work, complex problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
      "Keep narration brief and value-dense; avoid repeating obvious steps.",
    ].join("\n"),

    // ── Safety ───────────────────────────────────────────────────────────
    [
      "## Safety",
      "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
      "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards.",
      "Do not manipulate or persuade anyone to expand access or disable safeguards.",
    ].join("\n"),

    // ── Workspace ────────────────────────────────────────────────────────
    [
      "## Workspace",
      `Your working directory is: ${workspaceRoot}`,
      "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    ].join("\n"),

    // ── Date & Time ──────────────────────────────────────────────────────
    [
      "## Current Date & Time",
      `Date: ${formatLocalDate(today)}`,
      `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    ].join("\n"),

    // ── Heartbeats ───────────────────────────────────────────────────────
    [
      "## Heartbeats",
      "If you receive a heartbeat poll, and there is nothing that needs attention, reply exactly:",
      "HEARTBEAT_OK",
      "If something needs attention, do NOT include HEARTBEAT_OK; reply with the alert text instead.",
    ].join("\n"),

    // ── Silent Replies ───────────────────────────────────────────────────
    [
      "## Silent Replies",
      "When you have nothing to say, respond with ONLY: __SILENT__",
      "It must be your ENTIRE message — nothing else.",
      "Never append it to an actual response.",
    ].join("\n"),

    // ── Memory Recall ─────────────────────────────────────────────────────
    [
      "## Memory Recall",
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos:",
      `- Use \`grep\` to search MEMORY.md and memory/*.md for relevant keywords.`,
      `- Use \`read\` to pull only the needed sections.`,
      "- If low confidence after search, say you checked but found nothing relevant.",
      "Include Source: <path> when it helps the user verify memory snippets.",
    ].join("\n"),

    // ── Memory Policy ────────────────────────────────────────────────────
    defaultMemoryPrompt(),
  ];

  // ── Skills ───────────────────────────────────────────────────────────
  if (skillsContext.trim().length > 0) {
    sections.push([
      "## Skills (mandatory)",
      "Before replying: scan <available_skills> <description> entries.",
      "- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.",
      "- If multiple could apply: choose the most specific one, then read/follow it.",
      "- If none clearly apply: do not read any SKILL.md.",
      skillsContext,
    ].join("\n"));
  }

  // ── Project Context (SOUL.md, MEMORY.md, daily notes) ────────────────
  const contextFiles: { path: string; content: string }[] = [];
  const soul = readTextIfExists(soulPath, 5_000);
  if (soul) {
    contextFiles.push({ path: "SOUL.md", content: soul });
  }

  const durable = readTextIfExists(memoryPath, 5_000);
  if (durable) {
    contextFiles.push({ path: "MEMORY.md", content: durable });
  }

  for (const filePath of dailyFiles) {
    const daily = readTextIfExists(filePath, 3_000);
    if (daily) {
      const name = filePath.split("/").at(-1) ?? "memory.md";
      contextFiles.push({ path: `memory/${name}`, content: daily });
    }
  }

  if (contextFiles.length > 0) {
    const hasSoul = contextFiles.some((f) => f.path === "SOUL.md");
    sections.push([
      "# Project Context",
      "The following project context files have been loaded:",
      hasSoul
        ? "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it."
        : "",
      "",
      ...contextFiles.flatMap((f) => [`## ${f.path}`, "", f.content, ""]),
    ].filter(Boolean).join("\n"));
  }

  // ── Runtime (last section, like OpenClaw) ─────────────────────────────
  const runtimeLine = [
    `host=${hostname()}`,
    `os=${process.platform} (${process.arch})`,
    piProvider ? `provider=${piProvider}` : "",
    piModel ? `model=${piModel}` : "",
    `channel=telegram`,
    `date=${formatLocalDate(today)}`
  ].filter(Boolean).join(" | ");
  sections.push(`## Runtime\nRuntime: ${runtimeLine}`);

  return sections.join("\n\n");
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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
