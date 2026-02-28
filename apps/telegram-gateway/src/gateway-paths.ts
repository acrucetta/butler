import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_PAIRINGS_RELATIVE_PATH = ".data/gateway/pairings.json";
const DEFAULT_SESSIONS_RELATIVE_PATH = ".data/gateway/sessions.json";
const LEGACY_PAIRINGS_RELATIVE_PATH = "apps/telegram-gateway/.data/gateway/pairings.json";
const LEGACY_SESSIONS_RELATIVE_PATH = "apps/telegram-gateway/.data/gateway/sessions.json";

interface ResolveGatewayDataPathsInput {
  pairingsFileEnv?: string;
  sessionsFileEnv?: string;
  startDir?: string;
  logger?: Pick<Console, "log">;
}

export interface GatewayDataPaths {
  workspaceRoot: string;
  pairingsFile: string;
  sessionsFile: string;
}

export function resolveGatewayDataPaths(input: ResolveGatewayDataPathsInput = {}): GatewayDataPaths {
  const startDir = resolve(input.startDir ?? process.cwd());
  const logger = input.logger ?? console;
  const workspaceRoot = findWorkspaceRoot(startDir);

  return {
    workspaceRoot,
    pairingsFile: resolveDataFilePath(
      startDir,
      workspaceRoot,
      input.pairingsFileEnv,
      DEFAULT_PAIRINGS_RELATIVE_PATH,
      LEGACY_PAIRINGS_RELATIVE_PATH,
      logger
    ),
    sessionsFile: resolveDataFilePath(
      startDir,
      workspaceRoot,
      input.sessionsFileEnv,
      DEFAULT_SESSIONS_RELATIVE_PATH,
      LEGACY_SESSIONS_RELATIVE_PATH,
      logger
    )
  };
}

function resolveDataFilePath(
  startDir: string,
  workspaceRoot: string,
  explicitPath: string | undefined,
  defaultRelativePath: string,
  legacyRelativePath: string,
  logger: Pick<Console, "log">
): string {
  const normalizedExplicitPath = explicitPath?.trim();
  if (normalizedExplicitPath) {
    return resolve(startDir, normalizedExplicitPath);
  }

  const primaryPath = resolve(workspaceRoot, defaultRelativePath);
  const legacyPath = resolve(workspaceRoot, legacyRelativePath);
  if (!existsSync(primaryPath) && existsSync(legacyPath)) {
    mkdirSync(dirname(primaryPath), { recursive: true });
    copyFileSync(legacyPath, primaryPath);
    logger.log(`[gateway] migrated legacy data file ${legacyPath} -> ${primaryPath}`);
  }

  return primaryPath;
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (isWorkspaceRoot(current)) {
      return current;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

function isWorkspaceRoot(directory: string): boolean {
  return (
    existsSync(resolve(directory, "package.json")) &&
    existsSync(resolve(directory, "apps", "telegram-gateway")) &&
    existsSync(resolve(directory, "apps", "orchestrator")) &&
    existsSync(resolve(directory, "packages", "contracts"))
  );
}
