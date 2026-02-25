import { existsSync, statSync } from "node:fs";

export function getBuildArtifactIssue(input) {
  if (!existsSync(input.artifactPath)) {
    return `Missing build artifact for ${input.serviceName}: ${input.artifactLabel} (run 'npm run build')`;
  }

  if (!existsSync(input.sourcePath)) {
    return null;
  }

  const artifactMtime = statSync(input.artifactPath).mtimeMs;
  const sourceMtime = statSync(input.sourcePath).mtimeMs;
  if (artifactMtime + 1 < sourceMtime) {
    return (
      `Stale build artifact for ${input.serviceName}: ${input.artifactLabel} is older than ${input.sourceLabel} ` +
      `(run 'npm run build')`
    );
  }

  return null;
}
