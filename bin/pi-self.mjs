#!/usr/bin/env node

import { runButlerCli } from "./lib/butler-cli.mjs";

await runButlerCli({
  cliName: "pi-self",
  description: "Personal Pi + Telegram stack CLI (legacy alias; prefer butler)"
});
