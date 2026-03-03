import type { Job } from "@pi-self/contracts";
import type { McpSkillToolsRuntime } from "./mcp-skill-tools.js";
import type { ExecutionMode, ModelRoutingRuntime } from "./model-routing.js";
import type { OrchestratorClient } from "./orchestrator-client.js";
import type { PiSession } from "./pi-session.js";
import { discoverSkills, loadSkillsConfig } from "./skills-runtime.js";
import { type JobRunnerConfig, formatError, runJob, sleep } from "./job-runner.js";

export interface WorkerLoopConfig {
  orchestrator: OrchestratorClient;
  orchestratorBaseUrl: string;
  modelRouting: ModelRoutingRuntime;
  mcpSkillTools: McpSkillToolsRuntime;
  jobRunnerConfig: Omit<JobRunnerConfig, "orchestrator" | "modelRouting" | "executionMode">;
  workerId: string;
  pollMs: number;
  executionMode: ExecutionMode;
  piCwd: string;
  skillsConfigFile: string;
  skillsDir?: string;
}

export async function workerLoop(cfg: WorkerLoopConfig, signal: AbortSignal): Promise<void> {
  const { orchestrator, orchestratorBaseUrl, modelRouting, mcpSkillTools, jobRunnerConfig, workerId, pollMs, executionMode, piCwd, skillsConfigFile, skillsDir } = cfg;

  console.log(`[worker] started workerId=${workerId} mode=${executionMode} orchestrator=${orchestratorBaseUrl}`);

  if (executionMode === "embedded") {
    console.log(`[worker] embedded mode enabled`);
    console.log(`[worker] embedded workspace=${piCwd}`);
    console.log(`[worker] embedded sessions=${jobRunnerConfig.activeRuns ? "(shared)" : "(none)"}`);
    console.log(`[worker] model routing config source=${modelRouting.getSourceLabel()}`);
    console.log(`[worker] tool policy config source=${jobRunnerConfig.toolPolicy.getSourceLabel()}`);
    console.log(
      `[worker] skills config=${skillsConfigFile} mode=${jobRunnerConfig.skillsModeOverride ?? "config"} contextWindow=${jobRunnerConfig.skillsContextWindowOverride ?? "config"}`
    );

    const skillsConfig = loadSkillsConfig(skillsConfigFile);
    const discovered = discoverSkills(piCwd, skillsDir);
    const enabledIds = new Set(skillsConfig.enabledSkills);
    const mcpSkills = discovered.filter(
      (s) => enabledIds.has(s.id) && Object.keys(s.tools.mcpServers).length > 0
    );
    if (mcpSkills.length > 0) {
      const mcpTools = await mcpSkillTools.start(mcpSkills, (msg) => console.log(msg));
      if (mcpTools.length > 0) {
        modelRouting.setCustomTools(mcpTools as any);
        console.log(
          `[worker] MCP skill tools registered: ${mcpTools.map((t) => t.name).join(", ")}`
        );
      }
    }
  }

  const fullJobRunnerConfig: JobRunnerConfig = {
    ...jobRunnerConfig,
    executionMode,
    orchestrator,
    modelRouting
  };

  while (!signal.aborted) {
    try {
      const job = await orchestrator.claimJob(workerId);
      if (!job) {
        await sleep(pollMs);
        continue;
      }

      await runJob(job, fullJobRunnerConfig);
    } catch (error) {
      console.error(`[worker] loop error: ${formatError(error)}`);
      await sleep(pollMs);
    }
  }

  await mcpSkillTools.shutdown();
  await modelRouting.shutdown();
  console.log("[worker] shutdown complete");
}

