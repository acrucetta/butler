import { copyFileSync, existsSync, readFileSync } from "node:fs";

export function loadJsonWithLegacyFallback(
  primaryPath: string,
  legacyPath: string,
  logger: Pick<Console, "log"> = console
): unknown {
  if (existsSync(primaryPath)) {
    return JSON.parse(readFileSync(primaryPath, "utf8"));
  }

  if (existsSync(legacyPath)) {
    copyFileSync(legacyPath, primaryPath);
    logger.log(`[orchestrator] migrated legacy config ${legacyPath} -> ${primaryPath}`);
    return JSON.parse(readFileSync(primaryPath, "utf8"));
  }

  return {};
}
