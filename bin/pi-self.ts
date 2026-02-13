#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });
dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true });

type ServiceName = "orchestrator" | "worker" | "gateway";

const program = new Command();
program.name("pi-self").description("Personal Pi + Telegram stack CLI");

program
  .command("doctor")
  .description("Run environment and runtime checks")
  .option("--mode <mode>", "worker mode: mock|rpc", process.env.PI_EXEC_MODE ?? "mock")
  .action((options) => {
    const mode = parseMode(options.mode);
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
  .action(async (options) => {
    const mode = parseMode(options.mode);
    const includeOrchestrator = Boolean(options.orchestrator);
    const includeWorker = Boolean(options.worker);
    const includeGateway = Boolean(options.gateway);

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

    const children = new Map<ServiceName, ChildProcessWithoutNullStreams>();

    if (includeOrchestrator) {
      children.set(
        "orchestrator",
        spawnService("orchestrator", ["--workspace", "apps/orchestrator", "run", "dev"], process.env)
      );
    }

    if (includeWorker) {
      const env = {
        ...process.env,
        PI_EXEC_MODE: mode
      } as NodeJS.ProcessEnv;

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

    console.log(`pi-self up: started ${Array.from(children.keys()).join(", ")} (worker mode=${mode})`);

    let shuttingDown = false;

    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`pi-self up: shutting down (${signal})`);
      for (const child of children.values()) {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        for (const child of children.values()) {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }
      }, 2_500);
    };

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => shutdown(signal));
    }

    await new Promise<void>((resolvePromise) => {
      for (const [service, child] of children.entries()) {
        child.on("exit", (code, signal) => {
          console.log(`pi-self up: ${service} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
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

await program.parseAsync(process.argv);

function spawnService(name: ServiceName, npmArgs: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn("npm", npmArgs, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  pipeWithPrefix(name, child.stdout, process.stdout);
  pipeWithPrefix(name, child.stderr, process.stderr);

  return child;
}

function pipeWithPrefix(name: string, input: NodeJS.ReadableStream, output: NodeJS.WriteStream): void {
  const rl = readline.createInterface({ input });
  rl.on("line", (line) => {
    output.write(`[${name}] ${line}\n`);
  });
}

function parseMode(raw: string): "mock" | "rpc" {
  if (raw === "mock" || raw === "rpc") {
    return raw;
  }
  throw new Error(`Invalid mode '${raw}'. Expected 'mock' or 'rpc'.`);
}

function runDoctor(input: {
  mode: "mock" | "rpc";
  includeOrchestrator: boolean;
  includeWorker: boolean;
  includeGateway: boolean;
  strict: boolean;
}): string[] {
  const issues: string[] = [];

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

function requireValue(name: string, value: string | undefined, issues: string[]): void {
  if (!value || value.trim().length === 0) {
    issues.push(`Missing required env var: ${name}`);
  }
}

function requireSecret(
  name: string,
  value: string | undefined,
  issues: string[],
  strict: boolean
): void {
  if (!value || value.trim().length === 0) {
    issues.push(`Missing required secret: ${name}`);
    return;
  }

  if (value.length < 16) {
    const suffix = strict ? " (must be 16+ chars)" : "";
    issues.push(`Secret too short: ${name}${suffix}`);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
