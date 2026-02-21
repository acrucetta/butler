import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import dotenv from "dotenv";
import {
  DEFAULT_SKILLS_DIR,
  DEFAULT_SKILLS_CONFIG_PATH,
  DEFAULT_SKILLS_OUTPUT_DIR,
  disableSkill,
  defaultSkillsConfig,
  discoverSkills,
  enableSkill,
  loadSkillsConfig,
  mergeEnabledSkillsIntoMcp,
  resolveEnabledSkills,
  saveSkillsConfig,
  writeSkillScaffold
} from "./skills-lib.mjs";

const REQUIRED_KEYS = [
  "ORCH_GATEWAY_TOKEN",
  "ORCH_WORKER_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TG_OWNER_IDS"
];

const DEFAULT_MCP_SPEC_PATH = "config/mcp-clis.json";
const DEFAULT_MCPORTER_CONFIG_PATH = "config/mcporter.json";
const DEFAULT_MCP_TEMPLATE_DIR = ".data/mcp/templates";
const DEFAULT_MCP_TYPES_DIR = ".data/mcp/types";
const DEFAULT_MCP_BIN_DIR = ".data/mcp/bin";
const DEFAULT_TOOL_POLICY_SOURCE_PATH = "config/tool-policy.example.json";
const DEFAULT_TOOL_POLICY_OUTPUT_PATH = ".data/worker/tool-policy.json";
const SETUP_PREBUILT_SKILLS = ["readwise", "gmail", "google-calendar", "hey-email"];
const DEFAULT_TUI_CHAT_ID = "butler-tui-chat";
const DEFAULT_TUI_REQUESTER_ID = "butler-tui";
const DEFAULT_TUI_SESSION_KEY = "butler-tui";
const TUI_JOB_POLL_INTERVAL_MS = 1200;
const DEFAULT_EXEC_MODE = resolveDefaultExecMode();

export async function runButlerCli(options = {}) {
  const cliName = options.cliName ?? "butler";
  const description = options.description ?? "Personal Pi + Telegram stack CLI";

  dotenv.config({ path: resolve(process.cwd(), ".env") });
  dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true });

  const program = new Command();
  program.name(cliName).description(description);

  program
    .command("setup")
    .description("Interactive setup wizard for Telegram and local .env")
    .argument("[target]", "setup target", "telegram")
    .option("--env-path <path>", "path to env file", ".env")
    .option("--skills-dir <path>", "skills directory for prebuilt skill onboarding", DEFAULT_SKILLS_DIR)
    .option("--skills-config-path <path>", "path to skills config file for setup", DEFAULT_SKILLS_CONFIG_PATH)
    .option("--bot-token <value>", "Telegram bot token")
    .option("--owner-ids <value>", "comma-separated Telegram owner IDs")
    .option("--gateway-token <value>", "orchestrator gateway secret (16+ chars)")
    .option("--worker-token <value>", "orchestrator worker secret (16+ chars)")
    .option("--orch-base-url <value>", "orchestrator base URL", "http://127.0.0.1:8787")
    .option("--enable-media", "enable Telegram voice/photo understanding")
    .option("--disable-media", "disable Telegram voice/photo understanding")
    .option("--openai-api-key <value>", "OpenAI API key used for media transcription/vision")
    .option(
      "--skills <ids>",
      "comma-separated prebuilt skills to set explicitly (e.g. readwise,gmail); disables other prebuilt skills"
    )
    .option("--skill-env <pair>", "skill env key=value pair (repeatable)", collectRepeatableOption, [])
    .option("--skip-skill-setup", "skip prebuilt skill selection/configuration during setup")
    .option("--sync-selected-skills", "run skills sync for selected MCP-backed skills during setup")
    .option("--skip-skill-sync", "skip skill sync prompt/execution during setup")
    .option("--flow <flow>", "setup flow: quickstart|manual")
    .option("--yes", "non-interactive mode (use provided/current defaults)")
    .option("--skip-doctor", "skip running doctor after writing env")
    .action(async (target, cmdOptions) => {
      const normalized = String(target ?? "telegram").trim().toLowerCase();
      if (normalized !== "telegram") {
        console.error(`Unsupported setup target '${target}'. Supported target: telegram`);
        process.exitCode = 1;
        return;
      }

      await runSetupTelegram(cmdOptions, cliName);
    });

  program
    .command("doctor")
    .description("Run environment and runtime checks")
    .option("--mode <mode>", "worker mode: mock|rpc", DEFAULT_EXEC_MODE)
    .action((cmdOptions) => {
      const mode = parseMode(cmdOptions.mode);
      const issues = runDoctor({
        mode,
        includeGateway: true,
        includeWorker: true,
        includeOrchestrator: true,
        strict: false
      });

      if (issues.length === 0) {
        console.log("doctor: ok");
        return;
      }

      console.error("doctor: found issues");
      for (const issue of issues) {
        console.error(`- ${issue}`);
      }
      process.exitCode = 1;
    });

  program
    .command("up")
    .description("Run orchestrator + worker + gateway together")
    .option("--mode <mode>", "worker mode: mock|rpc", DEFAULT_EXEC_MODE)
    .option("--no-orchestrator", "do not start orchestrator")
    .option("--no-worker", "do not start worker")
    .option("--no-gateway", "do not start telegram gateway")
    .action(async (cmdOptions) => {
      const mode = parseMode(cmdOptions.mode);
      const includeOrchestrator = Boolean(cmdOptions.orchestrator);
      const includeWorker = Boolean(cmdOptions.worker);
      const includeGateway = Boolean(cmdOptions.gateway);

      const issues = runDoctor({
        mode,
        includeGateway,
        includeWorker,
        includeOrchestrator,
        strict: true
      });

      if (issues.length > 0) {
        console.error("Refusing to start due to configuration issues:");
        for (const issue of issues) {
          console.error(`- ${issue}`);
        }
        process.exit(1);
        return;
      }

      const children = new Map();

      if (includeOrchestrator) {
        children.set(
          "orchestrator",
          spawnService("orchestrator", ["--workspace", "apps/orchestrator", "run", "dev"], process.env)
        );
      }

      if (includeWorker) {
        const env = buildWorkerEnv({
          ...process.env,
          PI_EXEC_MODE: mode
        });

        children.set("worker", spawnService("worker", ["--workspace", "apps/vm-worker", "run", "dev"], env));
      }

      if (includeGateway) {
        children.set("gateway", spawnService("gateway", ["--workspace", "apps/telegram-gateway", "run", "dev"], process.env));
      }

      if (children.size === 0) {
        console.error("No services selected. Use defaults or pass --orchestrator/--worker/--gateway.");
        process.exit(1);
        return;
      }

      console.log(`${cliName} up: started ${Array.from(children.keys()).join(", ")} (worker mode=${mode})`);

      let shuttingDown = false;

      const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`${cliName} up: shutting down (${signal})`);
        for (const child of children.values()) {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          for (const child of children.values()) {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }
        }, 2500);
      };

      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => shutdown(signal));
      }

      await new Promise((resolvePromise) => {
        for (const [service, child] of children.entries()) {
          child.on("exit", (code, signal) => {
            console.log(`${cliName} up: ${service} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
            children.delete(service);
            if (!shuttingDown && children.size > 0) {
              shutdown(`${service}-exit`);
            }
            if (children.size === 0) {
              resolvePromise();
            }
          });
        }
      });
    });

  program
    .command("tui")
    .description("Open minimal remote command bar")
    .option("--kind <kind>", "default submit kind: task|run", process.env.BUTLER_TUI_KIND ?? "task")
    .option("--chat-id <id>", "synthetic chat id for TUI jobs", process.env.BUTLER_TUI_CHAT_ID ?? DEFAULT_TUI_CHAT_ID)
    .option(
      "--requester-id <id>",
      "synthetic requester id for TUI jobs",
      process.env.BUTLER_TUI_REQUESTER_ID ?? DEFAULT_TUI_REQUESTER_ID
    )
    .option(
      "--session-key <key>",
      "session key for submitted TUI jobs",
      process.env.BUTLER_TUI_SESSION_KEY ?? DEFAULT_TUI_SESSION_KEY
    )
    .option("--thread-id <id>", "optional thread id for submitted TUI jobs", process.env.BUTLER_TUI_THREAD_ID ?? "")
    .option("--message <text>", "optional prompt to send immediately after startup")
    .action(async (cmdOptions) => {
      const initialJobKind = parseTuiJobKind(cmdOptions.kind);
      await runButlerTui({
        initialJobKind,
        chatId: String(cmdOptions.chatId ?? DEFAULT_TUI_CHAT_ID).trim() || DEFAULT_TUI_CHAT_ID,
        requesterId: String(cmdOptions.requesterId ?? DEFAULT_TUI_REQUESTER_ID).trim() || DEFAULT_TUI_REQUESTER_ID,
        sessionKey: String(cmdOptions.sessionKey ?? DEFAULT_TUI_SESSION_KEY).trim() || DEFAULT_TUI_SESSION_KEY,
        threadId: String(cmdOptions.threadId ?? "").trim() || undefined,
        initialMessage: String(cmdOptions.message ?? "").trim()
      });
    });

  const mcp = program.command("mcp").description("Manage MCP server CLI wrappers via mcporter");
  const policy = program.command("policy").description("Manage worker tool policy config");
  const skills = program.command("skills").description("Manage OpenClaw-style skill packages");

  skills
    .command("init")
    .description("Create skills config file")
    .option("--config-path <path>", "path to skills config file", DEFAULT_SKILLS_CONFIG_PATH)
    .option("--force", "overwrite existing skills config")
    .action((cmdOptions) => {
      const configPath = resolve(process.cwd(), cmdOptions.configPath);
      if (existsSync(configPath) && !cmdOptions.force) {
        console.error(`skills init: file already exists at ${configPath} (use --force to overwrite)`);
        process.exitCode = 1;
        return;
      }

      saveSkillsConfig(configPath, defaultSkillsConfig());
      console.log(`skills init: wrote ${configPath}`);
      console.log("Next:");
      console.log(`- Add skills under ${resolve(process.cwd(), DEFAULT_SKILLS_DIR)}`);
      console.log(`- Run: npm run ${cliName} -- skills list`);
      console.log(`- Run: npm run ${cliName} -- skills sync`);
    });

  skills
    .command("list")
    .description("List discovered skills and effective enablement")
    .option("--config-path <path>", "path to skills config file", DEFAULT_SKILLS_CONFIG_PATH)
    .option("--skills-dir <path>", "skills directory", DEFAULT_SKILLS_DIR)
    .option("--env-path <path>", "path to env file for required credential checks", ".env")
    .action((cmdOptions) => {
      const configPath = resolve(process.cwd(), cmdOptions.configPath);
      const config = loadSkillsConfig(configPath);
      const envPath = resolve(process.cwd(), cmdOptions.envPath);
      const envValues = {
        ...readEnvMap(envPath),
        ...process.env
      };
      const allSkills = discoverSkills({
        workspaceRoot: process.cwd(),
        skillsDir: resolve(process.cwd(), cmdOptions.skillsDir)
      });
      const enabled = new Set(resolveEnabledSkills(allSkills, config).map((skill) => skill.id));

      console.log(
        `skills list: ${allSkills.length} discovered, ${enabled.size} enabled (mode=${config.mode}, config=${configPath})`
      );
      if (allSkills.length === 0) {
        console.log("- no skills found");
        return;
      }

      for (const skill of allSkills) {
        const missingEnv = (skill.env ?? []).filter((name) => !String(envValues[name] ?? "").trim());
        const status = enabled.has(skill.id) ? "enabled" : "disabled";
        const tags = skill.tags.length > 0 ? ` tags=${skill.tags.join(",")}` : "";
        const envStatus = missingEnv.length > 0 ? ` missingEnv=${missingEnv.join(",")}` : "";
        console.log(`- ${skill.id} (${status})${tags}${envStatus}`);
      }
    });

  skills
    .command("enable")
    .description("Enable a skill")
    .argument("<skill-id>", "skill id")
    .option("--config-path <path>", "path to skills config file", DEFAULT_SKILLS_CONFIG_PATH)
    .option("--skills-dir <path>", "skills directory", DEFAULT_SKILLS_DIR)
    .action((skillId, cmdOptions) => {
      const configPath = resolve(process.cwd(), cmdOptions.configPath);
      const normalized = normalizeSkillId(skillId);
      const discovered = discoverSkills({
        workspaceRoot: process.cwd(),
        skillsDir: resolve(process.cwd(), cmdOptions.skillsDir)
      });
      if (!discovered.find((skill) => skill.id === normalized)) {
        console.error(`skills enable: unknown skill '${skillId}'`);
        process.exitCode = 1;
        return;
      }
      enableSkill(configPath, normalized);
      console.log(`skills enable: ${skillId} enabled in ${configPath}`);
    });

  skills
    .command("disable")
    .description("Disable a skill")
    .argument("<skill-id>", "skill id")
    .option("--config-path <path>", "path to skills config file", DEFAULT_SKILLS_CONFIG_PATH)
    .action((skillId, cmdOptions) => {
      const configPath = resolve(process.cwd(), cmdOptions.configPath);
      disableSkill(configPath, skillId);
      console.log(`skills disable: ${skillId} disabled in ${configPath}`);
    });

  skills
    .command("setup")
    .description("Configure required env vars for a skill")
    .argument("<skill-id>", "skill id")
    .option("--skills-dir <path>", "skills directory", DEFAULT_SKILLS_DIR)
    .option("--env-path <path>", "path to env file", ".env")
    .option("--set <pair>", "key=value pair (repeatable)", collectRepeatableOption, [])
    .option("--yes", "non-interactive; apply only --set values")
    .action(async (skillId, cmdOptions) => {
      const normalized = normalizeSkillId(skillId);
      const skillsDir = resolve(process.cwd(), cmdOptions.skillsDir);
      const skill = discoverSkills({ workspaceRoot: process.cwd(), skillsDir }).find((entry) => entry.id === normalized);

      if (!skill) {
        console.error(`skills setup: unknown skill '${skillId}'`);
        process.exitCode = 1;
        return;
      }

      if (!Array.isArray(skill.env) || skill.env.length === 0) {
        console.log(`skills setup: ${normalized} does not declare required env vars`);
        return;
      }

      const envPath = resolve(process.cwd(), cmdOptions.envPath);
      const existing = readEnvMap(envPath);
      let explicit;
      try {
        explicit = parseKeyValuePairs(cmdOptions.set ?? []);
      } catch (error) {
        console.error(`skills setup: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      const updates = {};

      const interactive = process.stdin.isTTY && !Boolean(cmdOptions.yes);
      let rl = null;
      if (interactive) {
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
      }

      try {
        for (const key of skill.env) {
          const explicitValue = explicit[key];
          if (typeof explicitValue === "string") {
            updates[key] = explicitValue;
            continue;
          }

          const current = coalesce(process.env[key], existing[key]);
          if (interactive && rl) {
            updates[key] = await promptForValue(rl, key, current, true);
            continue;
          }

          if (current.length > 0) {
            updates[key] = current;
            continue;
          }

          console.error(`skills setup: missing ${key}. Provide --set ${key}=... or run interactively.`);
          process.exitCode = 1;
          return;
        }
      } finally {
        rl?.close();
      }

      upsertEnvFile(envPath, updates);
      console.log(`skills setup: wrote ${envPath}`);
      for (const key of skill.env) {
        console.log(`- ${key}=${maskSecret(String(updates[key] ?? ""))}`);
      }
    });

  skills
    .command("add")
    .alias("scaffold")
    .description("Create a new local skill scaffold")
    .argument("<skill-id>", "skill id (e.g. google-calendar)")
    .option("--skills-dir <path>", "skills directory", DEFAULT_SKILLS_DIR)
    .action((skillId, cmdOptions) => {
      try {
        const skillDir = writeSkillScaffold({
          id: skillId,
          workspaceRoot: process.cwd(),
          skillsDir: resolve(process.cwd(), cmdOptions.skillsDir)
        });
        console.log(`skills add: created ${skillDir}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  skills
    .command("sync")
    .description("Merge enabled skill MCP surfaces and run mcporter sync")
    .option("--config-path <path>", "path to skills config file", DEFAULT_SKILLS_CONFIG_PATH)
    .option("--skills-dir <path>", "skills directory", DEFAULT_SKILLS_DIR)
    .option("--mcp-spec-path <path>", "base MCP manifest file", DEFAULT_MCP_SPEC_PATH)
    .option("--mcporter-config-path <path>", "base mcporter config file (optional override)")
    .option("--output-dir <path>", "generated skill artifact directory", DEFAULT_SKILLS_OUTPUT_DIR)
    .option("--target <name>", "sync one target by name (repeatable)", collectRepeatableOption, [])
    .option("--dry-run", "print planned mcporter commands without executing")
    .option("--skip-types", "skip mcporter emit-ts for all targets")
    .action((cmdOptions) => {
      try {
        runSkillsSync({
          configPath: resolve(process.cwd(), cmdOptions.configPath),
          skillsDir: resolve(process.cwd(), cmdOptions.skillsDir),
          mcpSpecPath: resolve(process.cwd(), cmdOptions.mcpSpecPath),
          mcporterConfigPath: cmdOptions.mcporterConfigPath
            ? resolve(process.cwd(), cmdOptions.mcporterConfigPath)
            : undefined,
          outputDir: resolve(process.cwd(), cmdOptions.outputDir),
          targetNames: cmdOptions.target ?? [],
          dryRun: Boolean(cmdOptions.dryRun),
          skipTypes: Boolean(cmdOptions.skipTypes)
        });
      } catch (error) {
        console.error(`skills sync: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  policy
    .command("init")
    .description("Create worker tool policy config from default example")
    .option("--output-path <path>", "path to generated policy file", DEFAULT_TOOL_POLICY_OUTPUT_PATH)
    .option("--source-path <path>", "path to source policy template", DEFAULT_TOOL_POLICY_SOURCE_PATH)
    .option("--force", "overwrite existing policy file")
    .action((cmdOptions) => {
      const outputPath = resolve(process.cwd(), cmdOptions.outputPath);
      const sourcePath = resolve(process.cwd(), cmdOptions.sourcePath);

      if (existsSync(outputPath) && !cmdOptions.force) {
        console.error(`policy init: file already exists at ${outputPath} (use --force to overwrite)`);
        process.exitCode = 1;
        return;
      }

      if (!existsSync(sourcePath)) {
        console.error(`policy init: source template not found at ${sourcePath}`);
        process.exitCode = 1;
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
      } catch (error) {
        console.error(`policy init: invalid JSON in source template ${sourcePath}`);
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(`policy init: source template must be a JSON object (${sourcePath})`);
        process.exitCode = 1;
        return;
      }

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      console.log(`policy init: wrote ${outputPath}`);
      console.log("Next:");
      console.log(`- Set PI_TOOL_POLICY_FILE=${outputPath} (optional if using default path)`);
      console.log(`- Edit allow/deny patterns in ${outputPath}`);
      console.log(`- Restart worker to apply changes`);
    });

  mcp
    .command("init")
    .description("Create the MCP CLI manifest used by `mcp sync`")
    .option("--config-path <path>", "path to MCP manifest file", DEFAULT_MCP_SPEC_PATH)
    .option("--force", "overwrite existing manifest")
    .action((cmdOptions) => {
      const specPath = resolve(process.cwd(), cmdOptions.configPath);
      if (existsSync(specPath) && !cmdOptions.force) {
        console.error(`mcp init: manifest already exists at ${specPath} (use --force to overwrite)`);
        process.exitCode = 1;
        return;
      }

      mkdirSync(dirname(specPath), { recursive: true });
      writeFileSync(specPath, `${JSON.stringify(defaultMcpSpec(), null, 2)}\n`, "utf8");
      console.log(`mcp init: wrote ${specPath}`);
      console.log("Next:");
      console.log(`- Add server definitions to ${resolve(process.cwd(), DEFAULT_MCPORTER_CONFIG_PATH)}`);
      console.log(`- Add generation targets in ${specPath}`);
      console.log(`- Run: npm run ${cliName} -- mcp sync`);
    });

  mcp
    .command("list")
    .description("List MCP CLI targets from the manifest")
    .option("--config-path <path>", "path to MCP manifest file", DEFAULT_MCP_SPEC_PATH)
    .action((cmdOptions) => {
      const specPath = resolve(process.cwd(), cmdOptions.configPath);
      const spec = ensureMcpSpecFile(specPath, false);
      const targets = validateMcpTargets(spec.targets ?? [], specPath);

      if (targets.length === 0) {
        console.log(`mcp list: no targets configured in ${specPath}`);
        return;
      }

      console.log(`mcp list: ${targets.length} target(s) in ${specPath}`);
      for (const target of targets) {
        const emitTypes = target.emitTypes !== false ? "yes" : "no";
        console.log(
          `- ${target.name} -> selector='${target.selector}', emitTypes=${emitTypes}, timeoutMs=${target.timeoutMs}`
        );
      }
    });

  mcp
    .command("sync")
    .description("Generate/update local CLI wrappers for MCP targets")
    .option("--config-path <path>", "path to MCP manifest file", DEFAULT_MCP_SPEC_PATH)
    .option("--target <name>", "sync one target by name (repeatable)", collectRepeatableOption, [])
    .option("--dry-run", "print planned mcporter commands without executing")
    .option("--skip-types", "skip mcporter emit-ts for all targets")
    .action((cmdOptions) => {
      syncMcpTargets({
        specPath: resolve(process.cwd(), cmdOptions.configPath),
        targetNames: cmdOptions.target ?? [],
        dryRun: Boolean(cmdOptions.dryRun),
        skipTypes: Boolean(cmdOptions.skipTypes)
      });
    });

  await program.parseAsync(process.argv);
}

async function runButlerTui({ initialJobKind, chatId, requesterId, sessionKey, threadId, initialMessage }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("tui: requires an interactive TTY terminal");
    process.exitCode = 1;
    return;
  }

  const remoteContext = {
    baseUrl: coalesce(process.env.ORCH_BASE_URL, "http://127.0.0.1:8787"),
    gatewayToken: coalesce(process.env.ORCH_GATEWAY_TOKEN),
    chatId,
    requesterId,
    sessionKey,
    threadId
  };
  const remoteReady = remoteContext.gatewayToken.length >= 16;

  const state = {
    kind: initialJobKind,
    activeJob: null,
    lastJob: null,
    pollTimer: null,
    pollInFlight: false,
    commandInFlight: false
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  const renderPrompt = () => {
    rl.setPrompt(`butler:${state.kind}> `);
    rl.prompt();
  };

  const printLine = (line = "") => {
    process.stdout.write(`${line}\n`);
  };

  const printStatusLine = (line) => {
    process.stdout.write(`\n${line}\n`);
  };

  const stopPolling = () => {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  };

  const setActiveJob = (next) => {
    state.activeJob = next;
    if (!next || isTerminalJobStatus(next.status)) {
      stopPolling();
      return;
    }
    if (!state.pollTimer) {
      state.pollTimer = setInterval(() => {
        void pollActiveJob();
      }, TUI_JOB_POLL_INTERVAL_MS);
    }
  };

  const submitPrompt = async (promptText) => {
    const prompt = String(promptText ?? "").trim();
    if (!prompt) {
      printStatusLine("prompt is empty");
      return;
    }
    if (!remoteReady) {
      printStatusLine("missing ORCH_GATEWAY_TOKEN (set it in .env)");
      return;
    }
    if (state.activeJob && !isTerminalJobStatus(state.activeJob.status)) {
      printStatusLine(`job ${state.activeJob.id} is still active; use /status or /abort`);
      return;
    }

    const job = await tuiCreateJob(remoteContext, {
      kind: state.kind,
      prompt
    });
    const active = {
      id: String(job.id ?? ""),
      kind: String(job.kind ?? state.kind),
      status: String(job.status ?? "queued"),
      cursor: 0,
      resultText: String(job.resultText ?? ""),
      error: String(job.error ?? "")
    };
    setActiveJob(active);
    printStatusLine(`[${formatTuiClock()}] created ${active.id} (${active.status})`);
    if (active.status === "needs_approval") {
      printStatusLine("this run needs approval; use /approve");
    }
    await pollActiveJob();
  };

  const approveActiveJob = async () => {
    if (!state.activeJob?.id) {
      printStatusLine("no active job");
      return;
    }
    if (state.activeJob.status !== "needs_approval") {
      printStatusLine(`active job status is '${state.activeJob.status}', not needs_approval`);
      return;
    }
    const job = await tuiApproveJob(remoteContext, state.activeJob.id);
    state.activeJob.status = String(job.status ?? state.activeJob.status);
    printStatusLine(`[${formatTuiClock()}] approved ${state.activeJob.id}`);
    await pollActiveJob();
  };

  const abortActiveJob = async () => {
    if (!state.activeJob?.id) {
      printStatusLine("no active job");
      return;
    }
    const job = await tuiAbortJob(remoteContext, state.activeJob.id);
    state.activeJob.status = String(job.status ?? state.activeJob.status);
    printStatusLine(`[${formatTuiClock()}] abort requested for ${state.activeJob.id}`);
    await pollActiveJob();
  };

  const printJobSummary = (job) => {
    if (!job) {
      printStatusLine("no job yet");
      return;
    }
    const details = `id=${job.id} kind=${job.kind} status=${job.status}`;
    printStatusLine(details);
  };

  const pollActiveJob = async () => {
    if (!state.activeJob?.id || state.pollInFlight || isTerminalJobStatus(state.activeJob.status)) {
      return;
    }
    state.pollInFlight = true;
    try {
      const current = state.activeJob;
      const eventsPayload = await tuiGetJobEvents(remoteContext, current.id, current.cursor);
      const events = Array.isArray(eventsPayload?.events) ? eventsPayload.events : [];
      const nextCursor = Number(eventsPayload?.nextCursor);
      if (Number.isFinite(nextCursor) && nextCursor >= 0) {
        current.cursor = Math.floor(nextCursor);
      }
      for (const event of events) {
        current.resultText += extractAgentDelta(event);
      }

      const latest = await tuiGetJob(remoteContext, current.id);
      const previousStatus = current.status;
      current.status = String(latest.status ?? current.status);
      current.resultText = String(latest.resultText ?? current.resultText ?? "");
      current.error = String(latest.error ?? current.error ?? "");

      if (current.status !== previousStatus) {
        printStatusLine(`[${formatTuiClock()}] ${current.id} -> ${current.status}`);
        renderPrompt();
      }

      if (isTerminalJobStatus(current.status)) {
        stopPolling();
        state.lastJob = { ...current };
        setActiveJob(null);
        if (current.resultText.trim()) {
          printStatusLine(`result:\n${current.resultText.trim()}`);
        } else if (current.error.trim()) {
          printStatusLine(`error: ${current.error.trim()}`);
        } else {
          printStatusLine(`job ${current.id} finished with no output`);
        }
        renderPrompt();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printStatusLine(`poll failed: ${summarizeTuiText(message, 260)}`);
      renderPrompt();
    } finally {
      state.pollInFlight = false;
    }
  };

  const printHelp = () => {
    printLine("Commands:");
    printLine("  /help                 show this help");
    printLine("  /kind task|run        set default kind for next prompts");
    printLine("  /status               show current job status");
    printLine("  /approve              approve active run job");
    printLine("  /abort                abort active job");
    printLine("  /quit                 exit");
    printLine("Any non-command text submits a prompt.");
  };

  const runCommand = async (line) => {
    const text = String(line ?? "").trim();
    if (!text) {
      return;
    }

    if (!text.startsWith("/")) {
      await submitPrompt(text);
      return;
    }

    const [command, ...rest] = text.slice(1).trim().split(/\s+/);
    const name = String(command ?? "").toLowerCase();
    const args = rest.join(" ").trim();

    if (name === "help" || name === "h") {
      printHelp();
      return;
    }
    if (name === "quit" || name === "q" || name === "exit") {
      rl.close();
      return;
    }
    if (name === "kind") {
      if (!args) {
        printStatusLine(`current kind=${state.kind}`);
        return;
      }
      state.kind = parseTuiJobKind(args);
      printStatusLine(`kind=${state.kind}`);
      return;
    }
    if (name === "status") {
      printJobSummary(state.activeJob ?? state.lastJob);
      return;
    }
    if (name === "approve") {
      await approveActiveJob();
      return;
    }
    if (name === "abort") {
      await abortActiveJob();
      return;
    }
    if (name === "task" || name === "run") {
      state.kind = parseTuiJobKind(name);
      if (!args) {
        printStatusLine(`kind=${state.kind}`);
        return;
      }
      await submitPrompt(args);
      return;
    }

    printStatusLine(`unknown command '/${name}'. Use /help.`);
  };

  printLine("Butler TUI (Minimal)");
  printLine(`Remote: ${remoteContext.baseUrl}`);
  printLine(
    `Identity: chat=${remoteContext.chatId} requester=${remoteContext.requesterId} session=${remoteContext.sessionKey}${
      remoteContext.threadId ? ` thread=${remoteContext.threadId}` : ""
    }`
  );
  printLine("Type a prompt and press Enter. Use /help for commands.");
  if (!remoteReady) {
    printLine("Warning: ORCH_GATEWAY_TOKEN is missing/short; submit will fail until fixed.");
  }
  const connectivity = await tuiCheckOrchestratorConnectivity(remoteContext.baseUrl);
  if (!connectivity.ok) {
    printLine(
      `Warning: cannot reach orchestrator at ${remoteContext.baseUrl}. Run 'npm run up' or set ORCH_BASE_URL in .env.`
    );
  }
  printLine("");

  if (initialMessage) {
    await submitPrompt(initialMessage);
  }

  rl.on("line", async (line) => {
    if (state.commandInFlight) {
      printStatusLine("busy; wait for current command to finish");
      return;
    }
    state.commandInFlight = true;
    try {
      await runCommand(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printStatusLine(`command failed: ${summarizeTuiText(message, 260)}`);
    } finally {
      state.commandInFlight = false;
      renderPrompt();
    }
  });

  rl.on("SIGINT", () => {
    rl.close();
  });

  renderPrompt();
  await new Promise((resolvePromise) => {
    rl.on("close", () => {
      stopPolling();
      resolvePromise();
    });
  });
}

function isTerminalJobStatus(status) {
  return status === "completed" || status === "failed" || status === "aborted";
}

function formatTuiClock(rawTs = new Date().toISOString()) {
  const date = new Date(rawTs);
  if (Number.isNaN(date.getTime())) {
    return String(rawTs);
  }
  return date.toISOString().slice(11, 19);
}

function summarizeTuiText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function extractAgentDelta(event) {
  const delta = event?.data?.delta;
  return typeof delta === "string" ? delta : "";
}

async function tuiCreateJob(remoteContext, input) {
  const payload = {
    kind: input.kind,
    prompt: String(input.prompt ?? ""),
    channel: "telegram",
    chatId: remoteContext.chatId,
    requesterId: remoteContext.requesterId,
    sessionKey: remoteContext.sessionKey,
    requiresApproval: input.kind === "run",
    metadata: {
      source: "butler-tui"
    }
  };
  if (remoteContext.threadId) {
    payload.threadId = remoteContext.threadId;
  }
  const response = await tuiOrchestratorRequest(remoteContext, "/v1/jobs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!response?.job || typeof response.job !== "object") {
    throw new Error("invalid orchestrator response: missing job");
  }
  return response.job;
}

async function tuiGetJob(remoteContext, jobId) {
  const response = await tuiOrchestratorRequest(
    remoteContext,
    `/v1/jobs/${encodeURIComponent(String(jobId ?? ""))}`,
    {
      method: "GET"
    }
  );
  if (!response?.job || typeof response.job !== "object") {
    throw new Error("invalid orchestrator response: missing job");
  }
  return response.job;
}

async function tuiGetJobEvents(remoteContext, jobId, cursor) {
  const safeCursor = Number.isFinite(Number(cursor)) && Number(cursor) >= 0 ? Math.floor(Number(cursor)) : 0;
  return tuiOrchestratorRequest(
    remoteContext,
    `/v1/jobs/${encodeURIComponent(String(jobId ?? ""))}/events?cursor=${encodeURIComponent(String(safeCursor))}`,
    {
      method: "GET"
    }
  );
}

async function tuiApproveJob(remoteContext, jobId) {
  const response = await tuiOrchestratorRequest(
    remoteContext,
    `/v1/jobs/${encodeURIComponent(String(jobId ?? ""))}/approve`,
    {
      method: "POST",
      body: "{}"
    }
  );
  if (!response?.job || typeof response.job !== "object") {
    throw new Error("invalid orchestrator response: missing job");
  }
  return response.job;
}

async function tuiAbortJob(remoteContext, jobId) {
  const response = await tuiOrchestratorRequest(
    remoteContext,
    `/v1/jobs/${encodeURIComponent(String(jobId ?? ""))}/abort`,
    {
      method: "POST",
      body: "{}"
    }
  );
  if (!response?.job || typeof response.job !== "object") {
    throw new Error("invalid orchestrator response: missing job");
  }
  return response.job;
}

async function tuiCheckOrchestratorConnectivity(baseUrl) {
  const normalized = String(baseUrl ?? "").replace(/\/+$/g, "");
  if (!normalized) {
    return { ok: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 3000);

  try {
    const response = await fetch(`${normalized}/health`, {
      method: "GET",
      signal: controller.signal
    });
    return { ok: response.ok || response.status === 404 || response.status === 401 };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function tuiOrchestratorRequest(remoteContext, path, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 20_000);
  const baseUrl = String(remoteContext.baseUrl ?? "").replace(/\/+$/g, "");
  if (!baseUrl) {
    throw new Error("ORCH_BASE_URL is missing");
  }

  try {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": remoteContext.gatewayToken,
          ...(init?.headers ?? {})
        }
      });
    } catch (error) {
      throw new Error(buildTuiConnectionErrorMessage(error, baseUrl));
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`orchestrator request failed (${response.status}): ${summarizeTuiText(text, 260)}`);
    }
    if (response.status === 204) {
      return {};
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildTuiConnectionErrorMessage(error, baseUrl) {
  const message = error instanceof Error ? error.message : String(error);
  if (String(message).toLowerCase().includes("fetch failed")) {
    return `cannot reach orchestrator at ${baseUrl}; run 'npm run up' or set ORCH_BASE_URL in .env`;
  }
  return `cannot reach orchestrator at ${baseUrl}: ${message}`;
}

async function runSetupTelegram(cmdOptions, cliName) {
  const envFilePath = resolve(process.cwd(), cmdOptions.envPath);
  let fileVars = readEnvMap(envFilePath);
  const interactive = process.stdin.isTTY && !Boolean(cmdOptions.yes);
  const skillsDir = resolve(process.cwd(), cmdOptions.skillsDir ?? DEFAULT_SKILLS_DIR);
  const skillsConfigPath = resolve(process.cwd(), cmdOptions.skillsConfigPath ?? DEFAULT_SKILLS_CONFIG_PATH);
  const requestedFlow = normalizeSetupFlow(cmdOptions.flow);
  if (cmdOptions.flow && !requestedFlow) {
    console.error(`setup: invalid --flow '${cmdOptions.flow}'. Expected 'quickstart' or 'manual'.`);
    process.exitCode = 1;
    return;
  }
  let selectedFlow = requestedFlow ?? "manual";
  let prompter = null;

  try {
    if (interactive) {
      prompter = await createSetupPrompter();
      await prompter.intro("Butler setup");

      if (!normalizeSetupFlow(cmdOptions.flow)) {
        selectedFlow = await prompter.select({
          message: "Setup flow",
          initialValue: "quickstart",
          options: [
            { value: "quickstart", label: "Quickstart", hint: "Minimum prompts + defaults" },
            { value: "manual", label: "Manual", hint: "Configure all key fields" }
          ]
        });
      }

      const hasExistingConfig = existsSync(envFilePath) || existsSync(skillsConfigPath);
      if (hasExistingConfig) {
        const existingAction = await prompter.select({
          message: "Existing config detected. How should setup proceed?",
          initialValue: "modify",
          options: [
            { value: "keep", label: "Keep current config and exit" },
            { value: "modify", label: "Modify current config" },
            { value: "reset", label: "Reset setup values and re-run onboarding" }
          ]
        });

        if (existingAction === "keep") {
          await prompter.outro("Setup unchanged.");
          return;
        }
        if (existingAction === "reset") {
          fileVars = {};
        }
      }
    }
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      console.error("setup: canceled");
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  let explicitSkillEnv = {};
  try {
    explicitSkillEnv = parseKeyValuePairs(cmdOptions.skillEnv ?? []);
  } catch (error) {
    console.error(`setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  let explicitPrebuiltSkills = [];
  try {
    explicitPrebuiltSkills = parseSkillList(cmdOptions.skills);
  } catch (error) {
    console.error(`setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const values = {
    ORCH_GATEWAY_TOKEN: coalesce(cmdOptions.gatewayToken, process.env.ORCH_GATEWAY_TOKEN, fileVars.ORCH_GATEWAY_TOKEN),
    ORCH_WORKER_TOKEN: coalesce(cmdOptions.workerToken, process.env.ORCH_WORKER_TOKEN, fileVars.ORCH_WORKER_TOKEN),
    TELEGRAM_BOT_TOKEN: coalesce(cmdOptions.botToken, process.env.TELEGRAM_BOT_TOKEN, fileVars.TELEGRAM_BOT_TOKEN),
    TG_OWNER_IDS: coalesce(cmdOptions.ownerIds, process.env.TG_OWNER_IDS, fileVars.TG_OWNER_IDS),
    ORCH_BASE_URL: coalesce(cmdOptions.orchBaseUrl, process.env.ORCH_BASE_URL, fileVars.ORCH_BASE_URL, "http://127.0.0.1:8787"),
    TG_MEDIA_ENABLED: coalesce(
      cmdOptions.disableMedia ? "false" : undefined,
      cmdOptions.enableMedia ? "true" : undefined,
      process.env.TG_MEDIA_ENABLED,
      fileVars.TG_MEDIA_ENABLED,
      "true"
    ),
    OPENAI_API_KEY: coalesce(cmdOptions.openaiApiKey, process.env.OPENAI_API_KEY, fileVars.OPENAI_API_KEY)
  };

  if (!values.ORCH_GATEWAY_TOKEN) {
    values.ORCH_GATEWAY_TOKEN = generateSecret();
  }
  if (!values.ORCH_WORKER_TOKEN) {
    values.ORCH_WORKER_TOKEN = generateSecret();
  }

  try {
    if (interactive && prompter) {
      await prompter.note(
        [
          "Step 1/2: Access credentials",
          "Create bot token with @BotFather (/newbot), then provide owner IDs and OpenAI key."
        ].join("\n"),
        "Credentials"
      );

      values.TELEGRAM_BOT_TOKEN = await prompter.text({
        message: "TELEGRAM_BOT_TOKEN",
        initialValue: values.TELEGRAM_BOT_TOKEN,
        required: true
      });
      values.TG_OWNER_IDS = await prompter.text({
        message: "TG_OWNER_IDS (comma-separated Telegram user IDs)",
        initialValue: values.TG_OWNER_IDS,
        required: true
      });
      const enableMedia = await prompter.confirm({
        message: "Enable voice/photo understanding in Telegram gateway?",
        initialValue: parseBooleanLike(values.TG_MEDIA_ENABLED)
      });
      values.TG_MEDIA_ENABLED = enableMedia ? "true" : "false";
      values.OPENAI_API_KEY = enableMedia
        ? await prompter.text({
            message: "OPENAI_API_KEY (required when media is enabled)",
            initialValue: values.OPENAI_API_KEY,
            required: true
          })
        : "";

      if (selectedFlow === "manual") {
        await prompter.note("Step 2/2: Runtime secrets and endpoint", "Runtime");
        values.ORCH_GATEWAY_TOKEN = await prompter.text({
          message: "ORCH_GATEWAY_TOKEN (16+ chars)",
          initialValue: values.ORCH_GATEWAY_TOKEN,
          required: true
        });
        values.ORCH_WORKER_TOKEN = await prompter.text({
          message: "ORCH_WORKER_TOKEN (16+ chars)",
          initialValue: values.ORCH_WORKER_TOKEN,
          required: true
        });
        values.ORCH_BASE_URL = await prompter.text({
          message: "ORCH_BASE_URL",
          initialValue: values.ORCH_BASE_URL,
          required: false
        });
      } else {
        await prompter.note(
          "Step 2/2: Quickstart selected. Using generated/default runtime values.",
          "Runtime"
        );
      }
    }
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      console.error("setup: canceled");
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const setupIssues = validateSetupValues(values);
  if (setupIssues.length > 0) {
    console.error("setup: missing or invalid values");
    for (const issue of setupIssues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  let skillSetup;
  try {
    skillSetup = await runSetupSkillOnboarding({
      interactive,
      prompter,
      skipSkillSetup: Boolean(cmdOptions.skipSkillSetup),
      skillsDir,
      skillsConfigPath,
      explicitPrebuiltSkills,
      explicitEnv: explicitSkillEnv,
      envSources: {
        ...fileVars,
        ...process.env
      }
    });
  } catch (error) {
    console.error(`setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  upsertEnvFile(envFilePath, {
    ORCH_GATEWAY_TOKEN: values.ORCH_GATEWAY_TOKEN,
    ORCH_WORKER_TOKEN: values.ORCH_WORKER_TOKEN,
    TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN,
    TG_OWNER_IDS: values.TG_OWNER_IDS,
    ORCH_BASE_URL: values.ORCH_BASE_URL,
    TG_MEDIA_ENABLED: values.TG_MEDIA_ENABLED,
    OPENAI_API_KEY: values.OPENAI_API_KEY,
    ...skillSetup.envUpdates
  });

  console.log(`setup: wrote ${envFilePath}`);
  console.log(`- ORCH_GATEWAY_TOKEN=${maskSecret(values.ORCH_GATEWAY_TOKEN)}`);
  console.log(`- ORCH_WORKER_TOKEN=${maskSecret(values.ORCH_WORKER_TOKEN)}`);
  console.log(`- TELEGRAM_BOT_TOKEN=${maskSecret(values.TELEGRAM_BOT_TOKEN)}`);
  console.log(`- TG_OWNER_IDS=${values.TG_OWNER_IDS}`);
  console.log(`- ORCH_BASE_URL=${values.ORCH_BASE_URL}`);
  console.log(`- TG_MEDIA_ENABLED=${values.TG_MEDIA_ENABLED}`);
  if (values.OPENAI_API_KEY) {
    console.log(`- OPENAI_API_KEY=${maskSecret(values.OPENAI_API_KEY)}`);
  }
  if (skillSetup.enabledPrebuilt.length > 0) {
    console.log(`- PREBUILT_SKILLS_ENABLED=${skillSetup.enabledPrebuilt.join(",")}`);
  }
  for (const key of Object.keys(skillSetup.envUpdates).sort((left, right) => left.localeCompare(right))) {
    console.log(`- ${key}=${maskSecret(String(skillSetup.envUpdates[key] ?? ""))}`);
  }
  if (skillSetup.missingEnv.length > 0) {
    console.error("setup: selected skills missing required env vars");
    for (const entry of skillSetup.missingEnv) {
      console.error(`- ${entry}`);
    }
    console.error("Use --skill-env KEY=VALUE or run `npm run butler -- skills setup <id>` after setup.");
  }
  if (skillSetup.credentialWarnings.length > 0) {
    console.error("setup: selected skills require additional credential setup");
    for (const entry of skillSetup.credentialWarnings) {
      console.error(`- ${entry}`);
    }
  }

  dotenv.config({ path: envFilePath, override: true });

  if (!cmdOptions.skipDoctor) {
    const issues = runDoctor({
      mode: parseMode(process.env.PI_EXEC_MODE ?? "mock"),
      includeGateway: true,
      includeWorker: true,
      includeOrchestrator: true,
      strict: false
    });

    if (issues.length === 0) {
      console.log("doctor: ok");
    } else {
      console.error("doctor: found issues");
      for (const issue of issues) {
        console.error(`- ${issue}`);
      }
    }
  }

  const canSyncSelectedSkills = skillSetup.targetNames.length > 0 && !Boolean(cmdOptions.skipSkillSync);
  let shouldSyncSelectedSkills = canSyncSelectedSkills && Boolean(cmdOptions.syncSelectedSkills);
  if (canSyncSelectedSkills && interactive && !Boolean(cmdOptions.syncSelectedSkills) && prompter) {
    try {
      shouldSyncSelectedSkills = await prompter.confirm({
        message: `Run skills sync now for selected MCP-backed skills (${skillSetup.targetNames.join(", ")})?`,
        initialValue: true
      });
    } catch (error) {
      if (error instanceof SetupCancelledError) {
        console.error("setup: canceled");
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  if (shouldSyncSelectedSkills) {
    try {
      runSkillsSync({
        configPath: skillsConfigPath,
        skillsDir,
        mcpSpecPath: resolve(process.cwd(), DEFAULT_MCP_SPEC_PATH),
        mcporterConfigPath: undefined,
        outputDir: resolve(process.cwd(), DEFAULT_SKILLS_OUTPUT_DIR),
        targetNames: skillSetup.targetNames,
        dryRun: false,
        skipTypes: false
      });
    } catch (error) {
      console.error(`setup: skills sync failed (${error instanceof Error ? error.message : String(error)})`);
      console.error("Continue with setup and run `npm run butler -- skills sync` later.");
    }
  }

  console.log("");
  console.log(`Next steps:`);
  console.log(`- npm run ${cliName} -- up --mode mock`);
  console.log(`- npm run ${cliName} -- up --mode rpc`);
  if (interactive && prompter) {
    await prompter.outro("Butler setup complete.");
  }
}

async function runSetupSkillOnboarding(options) {
  const discovered = discoverSkills({
    workspaceRoot: process.cwd(),
    skillsDir: options.skillsDir
  });
  const skillById = new Map(discovered.map((skill) => [skill.id, skill]));
  const prebuiltSkillIds = SETUP_PREBUILT_SKILLS.filter((id) => skillById.has(id));
  const config = loadSkillsConfig(options.skillsConfigPath);
  const enabled = new Set((config.enabledSkills ?? []).map((id) => normalizeSkillId(id)));
  const managedSkills = new Set(prebuiltSkillIds);
  const envUpdates = {};
  const explicitEnv = options.explicitEnv ?? {};

  const explicitPrebuilt = new Set((options.explicitPrebuiltSkills ?? []).map((id) => normalizeSkillId(id)).filter(Boolean));
  if (explicitPrebuilt.size > 0) {
    for (const skillId of explicitPrebuilt) {
      if (!SETUP_PREBUILT_SKILLS.includes(skillId)) {
        throw new Error(`'${skillId}' is not a prebuilt setup skill`);
      }
      if (!skillById.has(skillId)) {
        throw new Error(`prebuilt skill '${skillId}' is not available in ${options.skillsDir}`);
      }
    }
    for (const prebuiltId of prebuiltSkillIds) {
      if (explicitPrebuilt.has(prebuiltId)) {
        enabled.add(prebuiltId);
      } else {
        enabled.delete(prebuiltId);
      }
    }
  }

  if (options.interactive && !options.skipSkillSetup && prebuiltSkillIds.length > 0) {
    let selectedIds;
    if (options.prompter) {
      selectedIds = await options.prompter.multiselect({
        message: "Step 3/3: Select prebuilt skills",
        initialValues: prebuiltSkillIds.filter((id) => enabled.has(id)),
        options: prebuiltSkillIds
          .map((id) => skillById.get(id))
          .filter(Boolean)
          .map((skill) => ({
            value: skill.id,
            label: skill.name && skill.name !== skill.id ? `${skill.name} (${skill.id})` : skill.id,
            hint: Array.isArray(skill.env) && skill.env.length > 0 ? `requires: ${skill.env.join(", ")}` : "no env required"
          }))
      });
    } else {
      console.log("");
      console.log("Prebuilt skills setup");
      console.log("Use arrow keys and spacebar to select skills, then press Enter.");
      selectedIds = await promptForSkillMultiSelect({
        title: "Select prebuilt skills",
        skills: prebuiltSkillIds.map((id) => skillById.get(id)).filter(Boolean),
        initialSelected: prebuiltSkillIds.filter((id) => enabled.has(id))
      });
    }

    for (const prebuiltId of prebuiltSkillIds) {
      if (selectedIds.includes(prebuiltId)) {
        enabled.add(prebuiltId);
      } else {
        enabled.delete(prebuiltId);
      }
    }

    const selectedForConfig = Array.from(managedSkills)
      .filter((id) => enabled.has(id))
      .sort((left, right) => left.localeCompare(right));
    for (const skillId of selectedForConfig) {
      const skill = skillById.get(skillId);
      if (!skill || !Array.isArray(skill.env) || skill.env.length === 0) {
        continue;
      }
      for (const key of skill.env) {
        const explicitValue = explicitEnv[key];
        if (typeof explicitValue === "string") {
          envUpdates[key] = explicitValue;
          continue;
        }
        const current = coalesce(String(envUpdates[key] ?? ""), process.env[key], options.envSources[key]);
        if (options.prompter) {
          envUpdates[key] = await options.prompter.text({
            message: `${skillId}:${key}`,
            initialValue: current,
            required: true
          });
        } else {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
          try {
            envUpdates[key] = await promptForValue(rl, `${skillId}:${key}`, current, true);
          } finally {
            rl.close();
          }
        }
      }
    }
  }

  const selectedForConfig = Array.from(managedSkills)
    .filter((id) => enabled.has(id))
    .sort((left, right) => left.localeCompare(right));
  const credentialWarnings = [];

  if (selectedForConfig.some((id) => id === "gmail" || id === "google-calendar")) {
    const googleCredentialResult = await runGoogleCredentialOnboarding({
      interactive: Boolean(options.interactive),
      prompter: options.prompter,
      explicitEnv,
      envSources: options.envSources
    });
    credentialWarnings.push(...googleCredentialResult.warnings);
    Object.assign(envUpdates, googleCredentialResult.envUpdates ?? {});
    if (googleCredentialResult.account) {
      envUpdates.GOG_ACCOUNT = googleCredentialResult.account;
    }
  }

  const missingEnv = [];
  for (const skillId of selectedForConfig) {
    const skill = skillById.get(skillId);
    if (!skill || !Array.isArray(skill.env) || skill.env.length === 0) {
      continue;
    }
    for (const key of skill.env) {
      if (Object.prototype.hasOwnProperty.call(envUpdates, key)) {
        continue;
      }
      const explicitValue = explicitEnv[key];
      if (typeof explicitValue === "string") {
        envUpdates[key] = explicitValue;
        continue;
      }
      const current = coalesce(process.env[key], options.envSources[key]);
      if (current.length > 0) {
        envUpdates[key] = current;
        continue;
      }
      missingEnv.push(`${skillId}:${key}`);
    }
  }

  const normalizedEnabled = Array.from(enabled)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  saveSkillsConfig(options.skillsConfigPath, {
    ...config,
    enabledSkills: normalizedEnabled
  });

  const enabledPrebuilt = prebuiltSkillIds.filter((id) => enabled.has(id));
  const targetNames = Array.from(
    new Set(
      selectedForConfig.flatMap((skillId) => {
        const skill = skillById.get(skillId);
        if (!skill || !skill.tools || !Array.isArray(skill.tools.targets)) {
          return [];
        }
        return skill.tools.targets.map((target) => target?.name).filter((name) => typeof name === "string");
      })
    )
  ).sort((left, right) => left.localeCompare(right));

  return {
    enabledPrebuilt,
    envUpdates,
    missingEnv,
    credentialWarnings,
    targetNames
  };
}

async function runGoogleCredentialOnboarding(options) {
  const warnings = [];

  if (!isCommandAvailable("gog")) {
    warnings.push("Google skills selected but `gog` is not installed on this host.");
    warnings.push("Install `gog`, run `gog auth login`, then verify with `gog auth list`.");
    return {
      warnings,
      account: ""
    };
  }

  let credentialStatus = getGogCredentialStatus();
  if (!credentialStatus.hasCredentials && options.interactive && options.prompter) {
    await options.prompter.note(
      [
        "No gog OAuth client credentials were found.",
        "",
        "To get them:",
        "1) Google Cloud Console -> APIs & Services -> Credentials",
        "2) Create credentials -> OAuth client ID -> Desktop app",
        "3) Enable Gmail API + Google Calendar API",
        "4) Download credentials JSON"
      ].join("\n"),
      "Google OAuth credentials"
    );

    const setCredentialsNow = await options.prompter.confirm({
      message: "Set gog OAuth credentials now from a credentials.json file?",
      initialValue: true
    });

    if (setCredentialsNow) {
      const credentialsPathInput = await options.prompter.text({
        message: "Path to credentials.json",
        initialValue: "~/Downloads/credentials.json",
        required: true
      });
      const credentialsPath = expandHomePath(credentialsPathInput);
      const setCredentials = spawnSync("gog", ["auth", "credentials", "set", credentialsPath], {
        cwd: process.cwd(),
        stdio: "inherit"
      });
      if (setCredentials.status !== 0) {
        warnings.push("`gog auth credentials set` did not complete successfully.");
      }
      credentialStatus = getGogCredentialStatus();
    }
  }

  if (!credentialStatus.hasCredentials) {
    if (credentialStatus.error) {
      warnings.push(`Unable to read gog OAuth credentials: ${credentialStatus.error}`);
    }
    warnings.push("No gog OAuth client credentials are configured.");
    warnings.push(
      "Create a Desktop OAuth client in Google Cloud Console, enable Gmail API + Google Calendar API, then run `gog auth credentials set /path/to/credentials.json`."
    );
    return {
      warnings,
      account: ""
    };
  }

  let authStatus = listGogAccounts();
  if (authStatus.accounts.length === 0 && options.interactive && options.prompter) {
    await options.prompter.note(
      [
        "Google skills selected.",
        "No `gog` account was detected yet.",
        "Setup can launch `gog auth login` now."
      ].join("\n"),
      "Google credentials"
    );

    const runLogin = await options.prompter.confirm({
      message: "Run `gog auth login` now?",
      initialValue: true
    });

    if (runLogin) {
      const login = spawnSync("gog", ["auth", "login"], {
        cwd: process.cwd(),
        stdio: "inherit"
      });
      if (login.status !== 0) {
        warnings.push("`gog auth login` did not complete successfully.");
      }
      authStatus = listGogAccounts();
    }
  }

  if (authStatus.accounts.length === 0) {
    if (authStatus.error) {
      warnings.push(`Unable to read gog accounts: ${authStatus.error}`);
    }
    warnings.push("No Google account found in `gog auth list`.");
    warnings.push("Complete auth with `gog auth login` (or copy `~/.gog/` for headless deployments).");
    return {
      warnings,
      account: ""
    };
  }

  let account = "";
  if (options.interactive && options.prompter) {
    const defaultAccount = authStatus.accounts[0] ?? "";
    const useAccountPin = await options.prompter.confirm({
      message: `Pin a default gog account in .env (GOG_ACCOUNT)?`,
      initialValue: true
    });
    if (useAccountPin) {
      account = await options.prompter.text({
        message: "GOG_ACCOUNT",
        initialValue: defaultAccount,
        required: true
      });
    }
  } else {
    account = authStatus.accounts[0] ?? "";
  }

  return {
    warnings,
    account
  };
}

function ensureMcpSpecFile(specPath, overwriteIfMissing) {
  if (!existsSync(specPath)) {
    if (!overwriteIfMissing) {
      console.error(`MCP manifest not found: ${specPath}`);
      console.error("Run `npm run butler -- mcp init` first.");
      process.exit(1);
    }

    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, `${JSON.stringify(defaultMcpSpec(), null, 2)}\n`, "utf8");
  }

  const raw = readFileSync(specPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Invalid JSON in MCP manifest: ${specPath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!parsed || typeof parsed !== "object") {
    console.error(`Invalid MCP manifest shape in ${specPath}`);
    process.exit(1);
  }

  return parsed;
}

function defaultMcpSpec() {
  return {
    mcporterConfigPath: DEFAULT_MCPORTER_CONFIG_PATH,
    templateDir: DEFAULT_MCP_TEMPLATE_DIR,
    typesDir: DEFAULT_MCP_TYPES_DIR,
    binDir: DEFAULT_MCP_BIN_DIR,
    targets: [
      {
        name: "codex",
        selector: "codex",
        emitTypes: true,
        timeoutMs: 120000
      }
    ]
  };
}

function resolveMcpPaths(spec) {
  return {
    mcporterConfigPath: resolve(process.cwd(), String(spec.mcporterConfigPath ?? DEFAULT_MCPORTER_CONFIG_PATH)),
    templateDir: resolve(process.cwd(), String(spec.templateDir ?? DEFAULT_MCP_TEMPLATE_DIR)),
    typesDir: resolve(process.cwd(), String(spec.typesDir ?? DEFAULT_MCP_TYPES_DIR)),
    binDir: resolve(process.cwd(), String(spec.binDir ?? DEFAULT_MCP_BIN_DIR))
  };
}

function validateMcpTargets(rawTargets, specPath) {
  if (!Array.isArray(rawTargets)) {
    console.error(`Invalid MCP manifest: targets must be an array (${specPath})`);
    process.exit(1);
  }

  const targets = [];
  const seen = new Set();

  for (const raw of rawTargets) {
    if (!raw || typeof raw !== "object") {
      console.error(`Invalid MCP target in ${specPath}: expected object`);
      process.exit(1);
    }

    const target = {
      name: String(raw.name ?? "").trim(),
      selector: String(raw.selector ?? "").trim(),
      emitTypes: raw.emitTypes !== false,
      timeoutMs: parsePositiveInteger(raw.timeoutMs, 120000)
    };

    if (!target.name || !/^[A-Za-z0-9_.-]+$/.test(target.name)) {
      console.error(`Invalid MCP target name '${target.name}' in ${specPath}`);
      process.exit(1);
    }
    if (!target.selector) {
      console.error(`MCP target '${target.name}' is missing selector in ${specPath}`);
      process.exit(1);
    }
    if (seen.has(target.name)) {
      console.error(`Duplicate MCP target name '${target.name}' in ${specPath}`);
      process.exit(1);
    }

    seen.add(target.name);
    targets.push(target);
  }

  return targets;
}

function runSkillsSync({
  configPath,
  skillsDir,
  mcpSpecPath,
  mcporterConfigPath,
  outputDir,
  targetNames,
  dryRun,
  skipTypes
}) {
  const config = loadSkillsConfig(configPath);
  const discovered = discoverSkills({
    workspaceRoot: process.cwd(),
    skillsDir
  });
  const enabled = resolveEnabledSkills(discovered, config);

  const baseSpec = ensureMcpSpecFile(mcpSpecPath, false);
  const baseTargets = validateMcpTargets(baseSpec.targets ?? [], mcpSpecPath);
  const resolvedMcporterConfigPath = resolve(
    process.cwd(),
    mcporterConfigPath ?? String(baseSpec.mcporterConfigPath ?? DEFAULT_MCPORTER_CONFIG_PATH)
  );
  if (!existsSync(resolvedMcporterConfigPath)) {
    throw new Error(`missing mcporter config at ${resolvedMcporterConfigPath}`);
  }

  const baseMcporter = JSON.parse(readFileSync(resolvedMcporterConfigPath, "utf8"));
  const merged = mergeEnabledSkillsIntoMcp({
    baseMcporter,
    baseTargets,
    enabledSkills: enabled
  });

  mkdirSync(outputDir, { recursive: true });
  const generatedMcporterPath = resolve(outputDir, "mcporter.generated.json");
  const generatedSpecPath = resolve(outputDir, "mcp-clis.generated.json");

  writeFileSync(generatedMcporterPath, `${JSON.stringify(merged.mcporter, null, 2)}\n`, "utf8");
  writeFileSync(
    generatedSpecPath,
    `${JSON.stringify(
      {
        ...baseSpec,
        mcporterConfigPath: generatedMcporterPath,
        targets: merged.targets
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`skills sync: ${discovered.length} discovered, ${enabled.length} enabled, ${merged.targets.length} merged targets`);
  console.log(`skills sync: generated ${generatedMcporterPath}`);
  console.log(`skills sync: generated ${generatedSpecPath}`);

  syncMcpTargets({
    specPath: generatedSpecPath,
    targetNames: targetNames ?? [],
    dryRun: Boolean(dryRun),
    skipTypes: Boolean(skipTypes)
  });
}

function syncMcpTargets({ specPath, targetNames, dryRun, skipTypes }) {
  const spec = ensureMcpSpecFile(specPath, false);
  const selectedNames = new Set(targetNames ?? []);
  const allTargets = validateMcpTargets(spec.targets ?? [], specPath);
  const targets = selectedNames.size > 0 ? allTargets.filter((target) => selectedNames.has(target.name)) : allTargets;

  if (targets.length === 0) {
    const selection = selectedNames.size > 0 ? ` matching ${Array.from(selectedNames).join(", ")}` : "";
    console.log(`mcp sync: no targets configured${selection}`);
    return;
  }

  const paths = resolveMcpPaths(spec);
  if (!existsSync(paths.mcporterConfigPath)) {
    console.error(`mcp sync: missing mcporter config at ${paths.mcporterConfigPath}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(paths.templateDir, { recursive: true });
  mkdirSync(paths.binDir, { recursive: true });
  mkdirSync(paths.typesDir, { recursive: true });

  console.log(`mcp sync: syncing ${targets.length} target(s)`);
  for (const target of targets) {
    const templatePath = resolve(paths.templateDir, `${target.name}.ts`);

    runMcporterCommand(
      [
        "generate-cli",
        target.selector,
        "--config",
        paths.mcporterConfigPath,
        "--name",
        target.name,
        "--runtime",
        "node",
        "--timeout",
        String(target.timeoutMs),
        "--output",
        templatePath
      ],
      dryRun
    );

    if (!dryRun) {
      if (!existsSync(templatePath)) {
        console.error(`mcp sync: expected generated template at ${templatePath}, but it was not created`);
        process.exit(1);
      }
      sanitizeGeneratedTemplate(templatePath);
      writeMcpLauncher(paths.binDir, target.name, templatePath);
    }

    if (!skipTypes && target.emitTypes !== false) {
      const outPath = resolve(paths.typesDir, `${target.name}.d.ts`);
      runMcporterCommand(
        [
          "emit-ts",
          target.selector,
          "--config",
          paths.mcporterConfigPath,
          "--mode",
          "types",
          "--out",
          outPath
        ],
        dryRun
      );
    }
  }

  console.log(`mcp sync: done. binaries are in ${paths.binDir}`);
}

function collectRepeatableOption(value, previous = []) {
  return [...previous, value];
}

function parseKeyValuePairs(pairs) {
  const parsed = {};
  for (const pair of pairs) {
    const text = String(pair ?? "");
    const index = text.indexOf("=");
    if (index <= 0) {
      throw new Error(`Invalid --set value '${text}'. Expected KEY=VALUE.`);
    }
    const key = text.slice(0, index).trim();
    const value = text.slice(index + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid env key '${key}' in --set '${text}'`);
    }
    parsed[key] = value;
  }
  return parsed;
}

function parseSkillList(raw) {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (typeof raw !== "string") {
    throw new Error("invalid --skills value");
  }
  const ids = raw
    .split(",")
    .map((value) => normalizeSkillId(value))
    .filter(Boolean);
  return Array.from(new Set(ids));
}

function normalizeSkillId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function parsePositiveInteger(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function runMcporterCommand(args, dryRun) {
  const fullArgs = ["--yes", "mcporter", ...args];
  const printable = ["npx", ...fullArgs].map(shellEscape).join(" ");

  if (dryRun) {
    console.log(`dry-run: ${printable}`);
    return;
  }

  const result = spawnSync("npx", fullArgs, {
    cwd: process.cwd(),
    stdio: "inherit"
  });

  if (result.status !== 0) {
    console.error(`mcporter command failed: ${printable}`);
    process.exit(result.status ?? 1);
  }
}

function writeMcpLauncher(binDir, name, templatePath) {
  const launcherPath = resolve(binDir, name);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `node --import tsx ${shellEscape(templatePath)} \"$@\"`,
    ""
  ].join("\n");
  writeFileSync(launcherPath, script, "utf8");
  chmodSync(launcherPath, 0o755);
}

function sanitizeGeneratedTemplate(templatePath) {
  const source = readFileSync(templatePath, "utf8");
  const sanitized = source.replace(
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$-]*-[A-Za-z0-9_$-]*)/g,
    '$1["$2"]'
  );

  if (sanitized !== source) {
    writeFileSync(templatePath, sanitized, "utf8");
  }
}

function buildWorkerEnv(env) {
  const repoRoot = process.cwd();
  const mcpBinDir = resolve(process.cwd(), process.env.BUTLER_MCP_BIN_DIR ?? DEFAULT_MCP_BIN_DIR);
  const next = { ...env };
  if (existsSync(mcpBinDir)) {
    next.PATH = prependPathEntry(mcpBinDir, env.PATH);
  }
  if (!next.PI_WORKSPACE || String(next.PI_WORKSPACE).trim().length === 0) {
    next.PI_WORKSPACE = repoRoot;
  }
  if (!next.PI_SESSION_ROOT || String(next.PI_SESSION_ROOT).trim().length === 0) {
    next.PI_SESSION_ROOT = resolve(repoRoot, ".data/worker/sessions");
  }
  next.BUTLER_MCP_BIN_DIR = mcpBinDir;
  return next;
}

function prependPathEntry(entry, currentPath) {
  const values = (currentPath ?? "").split(delimiter).filter((part) => part.length > 0);
  if (values.includes(entry)) {
    return values.join(delimiter);
  }
  return [entry, ...values].join(delimiter);
}

function isCommandAvailable(command) {
  const check = spawnSync("bash", ["-lc", `command -v ${shellEscape(command)} >/dev/null 2>&1`], {
    cwd: process.cwd()
  });
  return check.status === 0;
}

function expandHomePath(rawPath) {
  const value = String(rawPath ?? "").trim();
  if (!value) {
    return value;
  }
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function getGogCredentialStatus() {
  const result = spawnSync("gog", ["auth", "credentials", "list"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const combined = `${stdout}\n${stderr}`;
  const noCredentials = /No OAuth client credentials stored/i.test(combined);

  return {
    hasCredentials: result.status === 0 && !noCredentials,
    error: result.status === 0 ? "" : (stderr.trim() || stdout.trim() || `exit code ${result.status ?? 1}`)
  };
}

function listGogAccounts() {
  const result = spawnSync("gog", ["auth", "list"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const combined = `${stdout}\n${stderr}`;
  const matches = combined.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  const accounts = Array.from(new Set(matches.map((value) => value.trim()).filter(Boolean)));

  return {
    accounts,
    error: result.status === 0 ? "" : (stderr.trim() || stdout.trim() || `exit code ${result.status ?? 1}`)
  };
}

class SetupCancelledError extends Error {
  constructor(message = "setup canceled") {
    super(message);
    this.name = "SetupCancelledError";
  }
}

async function createSetupPrompter() {
  const prompts = await import("@clack/prompts");

  const guard = (value) => {
    if (prompts.isCancel(value)) {
      prompts.cancel("Setup canceled.");
      throw new SetupCancelledError();
    }
    return value;
  };

  return {
    intro: async (title) => {
      prompts.intro(title);
    },
    outro: async (message) => {
      prompts.outro(message);
    },
    note: async (message, title) => {
      prompts.note(message, title);
    },
    select: async ({ message, options, initialValue }) =>
      guard(
        await prompts.select({
          message,
          options,
          initialValue
        })
      ),
    multiselect: async ({ message, options, initialValues }) =>
      guard(
        await prompts.multiselect({
          message,
          options,
          initialValues,
          required: false
        })
      ),
    text: async ({ message, initialValue, required }) =>
      guard(
        await prompts.text({
          message,
          initialValue,
          validate: required ? (value) => (String(value ?? "").trim().length === 0 ? "Required" : undefined) : undefined
        })
      ),
    confirm: async ({ message, initialValue }) =>
      guard(
        await prompts.confirm({
          message,
          initialValue
        })
      )
  };
}

function promptForValue(rl, label, currentValue, required) {
  return new Promise((resolvePromise) => {
    const suffix = currentValue ? ` [${currentValue}]` : "";
    rl.question(`${label}${suffix}: `, (answer) => {
      const trimmed = answer.trim();
      if (!trimmed) {
        if (currentValue) {
          resolvePromise(currentValue);
          return;
        }
        if (required) {
          resolvePromise("");
          return;
        }
      }
      resolvePromise(trimmed || currentValue || "");
    });
  });
}

function normalizeSetupFlow(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "quickstart" || normalized === "manual") {
    return normalized;
  }
  return null;
}

function promptForSkillMultiSelect({ title, skills, initialSelected }) {
  const ids = Array.isArray(skills) ? skills.map((skill) => skill?.id).filter((id) => typeof id === "string") : [];
  if (ids.length === 0) {
    return Promise.resolve([]);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const fallback = Array.isArray(initialSelected) ? initialSelected : [];
    return Promise.resolve(ids.filter((id) => fallback.includes(id)));
  }

  const selected = new Set(ids.filter((id) => Array.isArray(initialSelected) && initialSelected.includes(id)));
  let cursor = 0;
  let renderedLines = 0;

  return new Promise((resolvePromise, rejectPromise) => {
    const input = process.stdin;
    const output = process.stdout;
    const canRaw = typeof input.setRawMode === "function";
    const wasRaw = canRaw ? Boolean(input.isRaw) : false;

    readline.emitKeypressEvents(input);
    input.resume();
    if (canRaw) {
      input.setRawMode(true);
    }
    output.write("\x1b[?25l");

    const render = () => {
      const lines = [];
      lines.push(title);
      lines.push("Use ↑/↓ to move, space to toggle, enter to confirm.");
      for (let index = 0; index < skills.length; index += 1) {
        const skill = skills[index];
        const id = skill.id;
        const isActive = index === cursor;
        const isSelected = selected.has(id);
        const pointer = isActive ? ">" : " ";
        const marker = isSelected ? "[x]" : "[ ]";
        const label = skill.name && skill.name !== id ? `${skill.name} (${id})` : id;
        lines.push(`${pointer} ${marker} ${label}`);
      }

      if (renderedLines > 0) {
        output.write(`\x1b[${renderedLines}A`);
      }
      for (const line of lines) {
        output.write("\x1b[2K");
        output.write(`${line}\n`);
      }
      if (renderedLines > lines.length) {
        for (let index = 0; index < renderedLines - lines.length; index += 1) {
          output.write("\x1b[2K\n");
        }
      }
      renderedLines = lines.length;
    };

    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      input.pause();
      if (canRaw) {
        input.setRawMode(wasRaw);
      }
      output.write("\x1b[?25h");
    };

    const finish = () => {
      cleanup();
      output.write("\x1b[2K");
      output.write("\n");
      resolvePromise(ids.filter((id) => selected.has(id)));
    };

    const cancel = () => {
      cleanup();
      output.write("\x1b[2K");
      output.write("\n");
      rejectPromise(new Error("setup canceled"));
    };

    const onKeypress = (_input, key) => {
      if (!key) {
        return;
      }
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }
      if (key.name === "up") {
        cursor = (cursor - 1 + skills.length) % skills.length;
        render();
        return;
      }
      if (key.name === "down") {
        cursor = (cursor + 1) % skills.length;
        render();
        return;
      }
      if (key.name === "space") {
        const skill = skills[cursor];
        if (skill) {
          if (selected.has(skill.id)) {
            selected.delete(skill.id);
          } else {
            selected.add(skill.id);
          }
        }
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

function spawnService(name, npmArgs, env) {
  const child = spawn("npm", npmArgs, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  pipeWithPrefix(name, child.stdout, process.stdout);
  pipeWithPrefix(name, child.stderr, process.stderr);

  return child;
}

function pipeWithPrefix(name, input, output) {
  const rl = readline.createInterface({ input });
  rl.on("line", (line) => {
    output.write(`[${name}] ${line}\n`);
  });
}

function resolveDefaultExecMode() {
  const explicit = String(process.env.PI_EXEC_MODE ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "mock" || explicit === "rpc") {
    return explicit;
  }

  const binary = process.env.PI_BINARY ?? "pi";
  const check = spawnSync("bash", ["-lc", `command -v ${shellEscape(binary)} >/dev/null 2>&1`], {
    cwd: process.cwd()
  });
  return check.status === 0 ? "rpc" : "mock";
}

function parseMode(raw) {
  if (raw === "mock" || raw === "rpc") {
    return raw;
  }
  throw new Error(`Invalid mode '${raw}'. Expected 'mock' or 'rpc'.`);
}

function parseTuiJobKind(raw) {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "task" || normalized === "run") {
    return normalized;
  }
  throw new Error(`Invalid kind '${raw}'. Expected 'task' or 'run'.`);
}

function parseBooleanLike(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function runDoctor(input) {
  const issues = [];

  if (input.includeOrchestrator || input.includeGateway) {
    requireSecret("ORCH_GATEWAY_TOKEN", process.env.ORCH_GATEWAY_TOKEN, issues, input.strict);
  }

  if (input.includeOrchestrator || input.includeWorker) {
    requireSecret("ORCH_WORKER_TOKEN", process.env.ORCH_WORKER_TOKEN, issues, input.strict);
  }

  if (input.includeGateway) {
    requireValue("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN, issues);
    requireValue("TG_OWNER_IDS", process.env.TG_OWNER_IDS, issues);
    if (parseBooleanLike(coalesce(process.env.TG_MEDIA_ENABLED, "true"))) {
      requireValue("OPENAI_API_KEY", process.env.OPENAI_API_KEY, issues);
    }
  }

  if (input.includeWorker && input.mode === "rpc") {
    const binary = process.env.PI_BINARY ?? "pi";
    const check = spawnSync("bash", ["-lc", `command -v ${shellEscape(binary)} >/dev/null 2>&1`], {
      cwd: process.cwd()
    });
    if (check.status !== 0) {
      issues.push(`PI_EXEC_MODE=rpc requires PI_BINARY to be installed (missing '${binary}')`);
    }
  }

  return issues;
}

function validateSetupValues(values) {
  const issues = [];
  for (const key of REQUIRED_KEYS) {
    if (!values[key] || values[key].trim().length === 0) {
      issues.push(`Missing required value: ${key}`);
    }
  }

  for (const key of ["ORCH_GATEWAY_TOKEN", "ORCH_WORKER_TOKEN"]) {
    const value = values[key] ?? "";
    if (value.length > 0 && value.length < 16) {
      issues.push(`${key} must be at least 16 characters`);
    }
  }

  if (parseBooleanLike(values.TG_MEDIA_ENABLED) && !String(values.OPENAI_API_KEY ?? "").trim()) {
    issues.push("OPENAI_API_KEY is required when TG_MEDIA_ENABLED=true");
  }

  return issues;
}

function requireValue(name, value, issues) {
  if (!value || value.trim().length === 0) {
    issues.push(`Missing required env var: ${name}`);
  }
}

function requireSecret(name, value, issues, strict) {
  if (!value || value.trim().length === 0) {
    issues.push(`Missing required secret: ${name}`);
    return;
  }

  if (value.length < 16) {
    const suffix = strict ? " (must be 16+ chars)" : "";
    issues.push(`Secret too short: ${name}${suffix}`);
  }
}

function readEnvMap(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const content = readFileSync(filePath, "utf8");
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const value = decodeEnvValue(match[2] ?? "");
    values[key] = value;
  }
  return values;
}

function upsertEnvFile(filePath, values) {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const seen = new Set();

  const updated = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!(key in values)) {
      return line;
    }

    seen.add(key);
    return `${key}=${encodeEnvValue(values[key] ?? "")}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      updated.push(`${key}=${encodeEnvValue(value ?? "")}`);
    }
  }

  const output = `${updated.join("\n").replace(/\n+$/g, "")}\n`;
  writeFileSync(filePath, output, "utf8");
}

function decodeEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function encodeEnvValue(value) {
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function coalesce(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function generateSecret() {
  return randomBytes(18).toString("base64url");
}

function maskSecret(value) {
  if (!value || value.length < 6) {
    return "******";
  }
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
