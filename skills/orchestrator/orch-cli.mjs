#!/usr/bin/env node
// Orchestrator tools CLI — lightweight proxy to the orchestrator HTTP API.
// Usage: orch <command> [--id <id>] [--raw '<json>'] [--limit N] [--triggerKey <key>]

const BASE_URL = process.env.ORCH_BASE_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.ORCH_GATEWAY_TOKEN || "";

const TOOL_MAP = {
  "cron-list":         "cron.list",
  "cron-add":          "cron.add",
  "cron-update":       "cron.update",
  "cron-remove":       "cron.remove",
  "cron-run":          "cron.run",
  "heartbeat-list":    "heartbeat.list",
  "heartbeat-add":     "heartbeat.add",
  "heartbeat-update":  "heartbeat.update",
  "heartbeat-remove":  "heartbeat.remove",
  "heartbeat-run":     "heartbeat.run",
  "proactive-runs":    "proactive.runs",
  "memory-search":     "memory.search",
  "memory-store":      "memory.store",
  "memory-ledger":     "memory.ledger",
  "memory-index":      "memory.index",
  "memory-status":     "memory.status",
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--raw" && args[i + 1]) {
      flags.raw = args[++i];
    } else if (args[i] === "--id" && args[i + 1]) {
      flags.id = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      flags.limit = parseInt(args[++i], 10);
    } else if (args[i] === "--triggerKey" && args[i + 1]) {
      flags.triggerKey = args[++i];
    } else if (args[i] === "--query" && args[i + 1]) {
      flags.query = args[++i];
    } else if (args[i] === "--text" && args[i + 1]) {
      flags.text = args[++i];
    } else if (args[i] === "--scope" && args[i + 1]) {
      flags.scope = args[++i];
    }
  }
  return { command, flags };
}

function buildArguments(command, flags) {
  // If --raw is provided, parse it as the full arguments object
  if (flags.raw) {
    return JSON.parse(flags.raw);
  }

  const args = {};
  if (flags.id) args.id = flags.id;
  if (flags.limit) args.limit = flags.limit;
  if (flags.triggerKey) args.triggerKey = flags.triggerKey;
  if (flags.query) args.query = flags.query;
  if (flags.text) args.text = flags.text;
  if (flags.scope) args.scope = flags.scope;
  return args;
}

function printHelp() {
  console.log(`orch — Orchestrator tools CLI

Usage: orch <command> [flags]

Cron rules:
  cron-list                          List all cron rules
  cron-add --raw '<json>'            Create/update a cron rule
  cron-remove --id <rule-id>         Delete a cron rule
  cron-run --id <rule-id>            Trigger a cron rule now

Heartbeat rules:
  heartbeat-list                     List all heartbeat rules
  heartbeat-add --raw '<json>'       Create/update a heartbeat rule
  heartbeat-remove --id <rule-id>    Delete a heartbeat rule
  heartbeat-run --id <rule-id>       Trigger a heartbeat rule now

Other:
  proactive-runs [--limit N]         List recent proactive runs
  memory-search --query <q>          Search memory
  memory-store --text <t> [--scope]  Store a memory entry
  memory-ledger [--limit N]          List memory ledger
  memory-index                       Rebuild memory index
  memory-status                      Memory index status

Flags:
  --raw '<json>'       Full JSON arguments (for add/update commands)
  --id <id>            Rule ID (for remove/run commands)
  --limit <N>          Result limit
  --triggerKey <key>   Filter by trigger key`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv);

  if (!command || command === "help" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  const tool = TOOL_MAP[command];
  if (!tool) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'orch help' for available commands.`);
    process.exit(1);
  }

  if (!TOKEN) {
    console.error("Error: ORCH_GATEWAY_TOKEN not set.");
    process.exit(1);
  }

  const body = {
    tool,
    arguments: buildArguments(command, flags),
  };

  const response = await fetch(`${BASE_URL}/v1/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": TOKEN,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error(`Error (${response.status}):`, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
