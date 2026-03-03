import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, resolve } from "node:path";
import { defaultMemoryPrompt, formatLocalDate } from "./job-runner.js";
import { ModelRoutingRuntime, type ExecutionMode } from "./model-routing.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import type { PiSession } from "./pi-session.js";
import { McpSkillToolsRuntime } from "./mcp-skill-tools.js";
import { parseSkillsMode } from "./skills-runtime.js";
import { ToolPolicyRuntime } from "./tool-policy.js";
import { workerLoop } from "./worker-loop.js";

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
const skillsConfigFile = resolve(piCwd, process.env.PI_SKILLS_CONFIG_FILE ?? ".data/skills/config.json");
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

const activeRuns = new Map<string, PiSession>();
const mcpSkillTools = new McpSkillToolsRuntime();

const shutdownController = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdownController.abort();
  });
}

await workerLoop(
  {
    orchestrator,
    orchestratorBaseUrl,
    modelRouting,
    mcpSkillTools,
    workerId,
    pollMs,
    executionMode,
    piCwd,
    skillsConfigFile,
    skillsDir,
    jobRunnerConfig: {
      toolPolicy,
      activeRuns,
      heartbeatMs,
      piCwd,
      piProvider,
      piModel,
      skillsConfigFile,
      skillsDir,
      skillsModeOverride,
      skillsContextWindowOverride,
      skillsMaxCharsOverride
    }
  },
  shutdownController.signal
);

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
