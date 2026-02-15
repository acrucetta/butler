#!/usr/bin/env node

import { runButlerCli } from "./lib/butler-cli.mjs";

await runButlerCli({
  cliName: "butler",
  description: "Butler CLI for the Pi + Telegram agent stack"
});
