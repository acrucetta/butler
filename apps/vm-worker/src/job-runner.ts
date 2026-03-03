import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { Job, JobEvent, JobEventType } from "@pi-self/contracts";
import type { ExecutionMode, ModelRoutingRuntime } from "./model-routing.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import type { PiSession } from "./pi-session.js";
import { type SkillsMode, resolveSkillsContext } from "./skills-runtime.js";
import type { ToolPolicyRuntime } from "./tool-policy.js";

export interface JobRunnerConfig {
  orchestrator: OrchestratorClient;
  modelRouting: ModelRoutingRuntime;
  toolPolicy: ToolPolicyRuntime;
  activeRuns: Map<string, PiSession>;
  executionMode: ExecutionMode;
  heartbeatMs: number;
  piCwd: string;
  piProvider?: string;
  piModel?: string;
  skillsConfigFile: string;
  skillsDir?: string;
  skillsModeOverride: SkillsMode | null;
  skillsContextWindowOverride: number | null;
  skillsMaxCharsOverride: number | null;
}

export async function runJob(job: Job, cfg: JobRunnerConfig): Promise<void> {
  const {
    orchestrator, modelRouting, toolPolicy, activeRuns, executionMode, heartbeatMs, piCwd,
    piProvider, piModel, skillsConfigFile, skillsDir,
    skillsModeOverride, skillsContextWindowOverride, skillsMaxCharsOverride
  } = cfg;

  console.log(`[worker] running job=${job.id} kind=${job.kind} session=${job.sessionKey}`);
  await postEvent(orchestrator, job.id, "log", "Worker started execution");

  if (executionMode === "mock") {
    await runMockJob(job, orchestrator);
    return;
  }

  const existingRun = activeRuns.get(job.sessionKey);
  if (existingRun && existingRun.isStreaming()) {
    console.log(`[worker] steering message into active session=${job.sessionKey} job=${job.id}`);
    await postEvent(orchestrator, job.id, "log", "Steered into active session");
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
          await postEvent(orchestrator, job.id, "log", "Abort requested by orchestrator");
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
      await postEvent(orchestrator, job.id, "agent_text_delta", undefined, { delta: chunk });
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
        orchestrator,
        job.id,
        "log",
        `Skills selected (${skillsContext.mode}): ${skillsContext.selected.map((skill) => skill.id).join(", ")}`
      );
    }

    const preparedPrompt = job.prompt;
    const plan = modelRouting.buildPlan(job);
    await postEvent(
      orchestrator,
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
        orchestrator,
        job.id,
        "log",
        `Model attempt ${attempt + 1}/${plan.maxAttempts}: ${profile.id} (${profile.provider ?? "default"}/${profile.model ?? "default"})`
      );
      const policyContext = toolPolicy.resolveContext(job.kind, profile.id);
      const allowSummary = policyContext.allow === null ? "*" : policyContext.allow.join(", ");
      const denySummary = policyContext.deny.length > 0 ? policyContext.deny.join(", ") : "(none)";
      await postEvent(
        orchestrator,
        job.id,
        "log",
        `Tool policy for attempt: allow=[${allowSummary}] deny=[${denySummary}]`
      );

      const session = modelRouting.getSession(profile.id, job.sessionKey);
      activeSession = session;
      activeRuns.set(job.sessionKey, session);

      const systemPrompt = buildSystemPromptContext(piCwd, skillsContext.context, piProvider, piModel);
      if (systemPrompt) {
        session.setSystemPrompt(systemPrompt);
      }

      const allTools = session.getAllToolNames();
      if (allTools.length > 0) {
        const allowedTools = allTools.filter((name) => policyContext.evaluateTool(name).allowed);
        if (allowedTools.length < allTools.length) {
          session.setActiveTools(allowedTools);
          const disabledCount = allTools.length - allowedTools.length;
          await postEvent(orchestrator, job.id, "log", `Tool policy disabled ${disabledCount} tool(s) before prompt`);
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
            void postEvent(orchestrator, job.id, "tool_start", `Tool started: ${toolName}`, { toolName });
          },
          onToolEnd(toolName) {
            attemptHadToolActivity = true;
            void postEvent(orchestrator, job.id, "tool_end", `Tool finished: ${toolName}`, { toolName });
          },
          onLog(message) {
            void postEvent(orchestrator, job.id, "log", message);
          }
        });

        await flushDelta();
        finalResult = result.trim().length > 0 ? result : fullText;

        if (finalResult.trim().length === 0 && !attemptHadOutput && !attemptHadToolActivity) {
          const warnMsg = "Warning: model returned empty response with no tool activity — possible upstream API error (check provider key limits/credits)";
          await postEvent(orchestrator, job.id, "log", warnMsg);
          console.warn(`[worker] ${warnMsg} job=${job.id} profile=${profile.id}`);

          const hasNextAttempt = attempt + 1 < plan.maxAttempts;
          if (hasNextAttempt) {
            continue;
          }
        }

        modelRouting.markSuccess(profile.id);
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
          orchestrator,
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

    const isProactiveJob = job.sessionKey?.startsWith("proactive:");
    const isSilent = isProactiveJob && finalResult.trim() === "__SILENT__";
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

async function runMockJob(job: Job, orchestrator: OrchestratorClient): Promise<void> {
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

    await postEvent(orchestrator, job.id, "log", step);
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
  orchestrator: OrchestratorClient,
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

export function buildSystemPromptContext(workspaceRoot: string, skillsContext: string, piProvider?: string, piModel?: string): string {
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

    [
      "## Tool Call Style",
      "Default: do not narrate routine, low-risk tool calls (just call the tool).",
      "Narrate only when it helps: multi-step work, complex problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
      "Keep narration brief and value-dense; avoid repeating obvious steps.",
    ].join("\n"),

    [
      "## Safety",
      "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
      "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards.",
      "Do not manipulate or persuade anyone to expand access or disable safeguards.",
    ].join("\n"),

    [
      "## Workspace",
      `Your working directory is: ${workspaceRoot}`,
      "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    ].join("\n"),

    [
      "## Current Date & Time",
      `Date: ${formatLocalDate(today)}`,
      `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    ].join("\n"),

    [
      "## Heartbeats",
      "If you receive a heartbeat poll, and there is nothing that needs attention, reply exactly:",
      "HEARTBEAT_OK",
      "If something needs attention, do NOT include HEARTBEAT_OK; reply with the alert text instead.",
    ].join("\n"),

    [
      "## Silent Replies",
      "When a PROACTIVE or SCHEDULED task has nothing to report, respond with ONLY: __SILENT__",
      "It must be your ENTIRE message — nothing else.",
      "Never append it to an actual response.",
      "NEVER use __SILENT__ when replying to a direct user message — always respond to the user, even with a brief acknowledgment.",
    ].join("\n"),

    [
      "## Memory Recall",
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos:",
      `- Use \`grep\` to search MEMORY.md and memory/*.md for relevant keywords.`,
      `- Use \`read\` to pull only the needed sections.`,
      "- If low confidence after search, say you checked but found nothing relevant.",
      "Include Source: <path> when it helps the user verify memory snippets.",
    ].join("\n"),

    defaultMemoryPrompt(),
  ];

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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultMemoryPrompt(): string {
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
