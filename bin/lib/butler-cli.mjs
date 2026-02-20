import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
    .option("--bot-token <value>", "Telegram bot token")
    .option("--owner-ids <value>", "comma-separated Telegram owner IDs")
    .option("--gateway-token <value>", "orchestrator gateway secret (16+ chars)")
    .option("--worker-token <value>", "orchestrator worker secret (16+ chars)")
    .option("--orch-base-url <value>", "orchestrator base URL", "http://127.0.0.1:8787")
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
    .option("--mode <mode>", "worker mode: mock|rpc", process.env.PI_EXEC_MODE ?? "mock")
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
    .option("--mode <mode>", "worker mode: mock|rpc", process.env.PI_EXEC_MODE ?? "mock")
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
        const configPath = resolve(process.cwd(), cmdOptions.configPath);
        const config = loadSkillsConfig(configPath);
        const discovered = discoverSkills({
          workspaceRoot: process.cwd(),
          skillsDir: resolve(process.cwd(), cmdOptions.skillsDir)
        });
        const enabled = resolveEnabledSkills(discovered, config);

        const baseSpecPath = resolve(process.cwd(), cmdOptions.mcpSpecPath);
        const baseSpec = ensureMcpSpecFile(baseSpecPath, false);
        const baseTargets = validateMcpTargets(baseSpec.targets ?? [], baseSpecPath);

        const mcporterConfigPath = resolve(
          process.cwd(),
          cmdOptions.mcporterConfigPath ?? String(baseSpec.mcporterConfigPath ?? DEFAULT_MCPORTER_CONFIG_PATH)
        );
        if (!existsSync(mcporterConfigPath)) {
          console.error(`skills sync: missing mcporter config at ${mcporterConfigPath}`);
          process.exitCode = 1;
          return;
        }

        const baseMcporter = JSON.parse(readFileSync(mcporterConfigPath, "utf8"));
        const merged = mergeEnabledSkillsIntoMcp({
          baseMcporter,
          baseTargets,
          enabledSkills: enabled
        });

        const outputDir = resolve(process.cwd(), cmdOptions.outputDir);
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

        console.log(
          `skills sync: ${discovered.length} discovered, ${enabled.length} enabled, ${merged.targets.length} merged targets`
        );
        console.log(`skills sync: generated ${generatedMcporterPath}`);
        console.log(`skills sync: generated ${generatedSpecPath}`);

        syncMcpTargets({
          specPath: generatedSpecPath,
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

async function runSetupTelegram(cmdOptions, cliName) {
  const envFilePath = resolve(process.cwd(), cmdOptions.envPath);
  const fileVars = readEnvMap(envFilePath);
  const interactive = process.stdin.isTTY && !Boolean(cmdOptions.yes);

  const values = {
    ORCH_GATEWAY_TOKEN: coalesce(cmdOptions.gatewayToken, process.env.ORCH_GATEWAY_TOKEN, fileVars.ORCH_GATEWAY_TOKEN),
    ORCH_WORKER_TOKEN: coalesce(cmdOptions.workerToken, process.env.ORCH_WORKER_TOKEN, fileVars.ORCH_WORKER_TOKEN),
    TELEGRAM_BOT_TOKEN: coalesce(cmdOptions.botToken, process.env.TELEGRAM_BOT_TOKEN, fileVars.TELEGRAM_BOT_TOKEN),
    TG_OWNER_IDS: coalesce(cmdOptions.ownerIds, process.env.TG_OWNER_IDS, fileVars.TG_OWNER_IDS),
    ORCH_BASE_URL: coalesce(cmdOptions.orchBaseUrl, process.env.ORCH_BASE_URL, fileVars.ORCH_BASE_URL, "http://127.0.0.1:8787")
  };

  if (!values.ORCH_GATEWAY_TOKEN) {
    values.ORCH_GATEWAY_TOKEN = generateSecret();
  }
  if (!values.ORCH_WORKER_TOKEN) {
    values.ORCH_WORKER_TOKEN = generateSecret();
  }

  if (interactive) {
    console.log("Telegram setup wizard");
    console.log("1) Create bot token with @BotFather (/newbot)");
    console.log("2) Collect your Telegram user id");
    console.log("3) Save .env and run doctor");
    console.log("");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      values.TELEGRAM_BOT_TOKEN = await promptForValue(rl, "TELEGRAM_BOT_TOKEN", values.TELEGRAM_BOT_TOKEN, true);
      values.TG_OWNER_IDS = await promptForValue(
        rl,
        "TG_OWNER_IDS (comma-separated Telegram user IDs)",
        values.TG_OWNER_IDS,
        true
      );
      values.ORCH_GATEWAY_TOKEN = await promptForValue(
        rl,
        "ORCH_GATEWAY_TOKEN (16+ chars)",
        values.ORCH_GATEWAY_TOKEN,
        true
      );
      values.ORCH_WORKER_TOKEN = await promptForValue(
        rl,
        "ORCH_WORKER_TOKEN (16+ chars)",
        values.ORCH_WORKER_TOKEN,
        true
      );
      values.ORCH_BASE_URL = await promptForValue(rl, "ORCH_BASE_URL", values.ORCH_BASE_URL, false);
    } finally {
      rl.close();
    }
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

  upsertEnvFile(envFilePath, {
    ORCH_GATEWAY_TOKEN: values.ORCH_GATEWAY_TOKEN,
    ORCH_WORKER_TOKEN: values.ORCH_WORKER_TOKEN,
    TELEGRAM_BOT_TOKEN: values.TELEGRAM_BOT_TOKEN,
    TG_OWNER_IDS: values.TG_OWNER_IDS,
    ORCH_BASE_URL: values.ORCH_BASE_URL
  });

  console.log(`setup: wrote ${envFilePath}`);
  console.log(`- ORCH_GATEWAY_TOKEN=${maskSecret(values.ORCH_GATEWAY_TOKEN)}`);
  console.log(`- ORCH_WORKER_TOKEN=${maskSecret(values.ORCH_WORKER_TOKEN)}`);
  console.log(`- TELEGRAM_BOT_TOKEN=${maskSecret(values.TELEGRAM_BOT_TOKEN)}`);
  console.log(`- TG_OWNER_IDS=${values.TG_OWNER_IDS}`);
  console.log(`- ORCH_BASE_URL=${values.ORCH_BASE_URL}`);

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

  console.log("");
  console.log(`Next steps:`);
  console.log(`- npm run ${cliName} -- up --mode mock`);
  console.log(`- npm run ${cliName} -- up --mode rpc`);
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

function parseMode(raw) {
  if (raw === "mock" || raw === "rpc") {
    return raw;
  }
  throw new Error(`Invalid mode '${raw}'. Expected 'mock' or 'rpc'.`);
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
