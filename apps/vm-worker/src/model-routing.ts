import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Job, JobKind } from "@pi-self/contracts";
import { PiRpcSessionPool, type PiRpcSession } from "./pi-rpc-session.js";

const DEFAULT_RETRYABLE_ERROR_PATTERNS = [
  "rate limit",
  "timeout",
  "timed out",
  "connection reset",
  "connection refused",
  "econnreset",
  "ehostunreach",
  "etimedout",
  "429",
  "503",
  "502",
  "provider",
  "model",
  "authentication",
  "auth",
  "api key"
];

const DEFAULT_COOLDOWN_SECONDS = 180;
const DEFAULT_MAX_ATTEMPTS_PER_JOB = 3;
const MAX_MAX_ATTEMPTS_PER_JOB = 8;

interface ModelProfileConfig {
  id: string;
  provider?: string;
  model?: string;
  appendSystemPrompt?: string;
  cooldownSeconds?: number;
  env?: Record<string, string>;
  envFrom?: Record<string, string>;
}

interface RoutingConfig {
  profiles: ModelProfileConfig[];
  routes?: {
    default?: string[];
    task?: string[];
    run?: string[];
  };
  maxAttemptsPerJob?: number;
  retryableErrorPatterns?: string[];
}

export interface ResolvedModelProfile {
  id: string;
  provider?: string;
  model?: string;
  appendSystemPrompt?: string;
  cooldownSeconds: number;
  env: Record<string, string>;
}

interface BuildPlanOptions {
  requestedProfileId?: string;
  kind: JobKind;
}

export interface ModelAttemptPlan {
  profiles: ResolvedModelProfile[];
  maxAttempts: number;
}

export interface FallbackEvaluationInput {
  abortRequested: boolean;
  attemptHadOutput: boolean;
  attemptHadToolActivity: boolean;
  errorMessage: string;
}

interface RuntimeOptions {
  piBinary: string;
  cwd: string;
  sessionRoot: string;
  appendSystemPrompt: string;
  defaultProvider?: string;
  defaultModel?: string;
  configFilePath?: string;
  requireConfigFile?: boolean;
  logger?: Pick<Console, "log" | "warn">;
}

export class ModelRoutingRuntime {
  private readonly profilesById = new Map<string, ResolvedModelProfile>();
  private readonly poolsById = new Map<string, PiRpcSessionPool>();
  private readonly cooldownUntilMsByProfile = new Map<string, number>();
  private readonly routes: Required<NonNullable<RoutingConfig["routes"]>>;
  private readonly retryablePatterns: string[];
  private readonly maxAttemptsPerJob: number;
  private readonly sourceLabel: string;
  private readonly logger: Pick<Console, "log" | "warn">;

  constructor(private readonly options: RuntimeOptions) {
    this.logger = options.logger ?? console;

    const loaded = loadRoutingConfig({
      configFilePath: options.configFilePath,
      requireConfigFile: options.requireConfigFile,
      defaultProvider: options.defaultProvider,
      defaultModel: options.defaultModel
    });

    this.sourceLabel = loaded.sourceLabel;

    for (const profile of loaded.config.profiles) {
      const resolved = resolveProfile(profile, options.appendSystemPrompt);
      if (this.profilesById.has(resolved.id)) {
        throw new Error(`Duplicate model profile id '${resolved.id}'`);
      }
      this.profilesById.set(resolved.id, resolved);
    }

    if (this.profilesById.size === 0) {
      throw new Error("Model routing requires at least one profile");
    }

    const firstProfileId = this.profilesById.keys().next().value;
    if (!firstProfileId) {
      throw new Error("Model routing profile initialization failed");
    }

    this.routes = {
      default: normalizeRouteIds(loaded.config.routes?.default, firstProfileId),
      task: normalizeRouteIds(loaded.config.routes?.task, firstProfileId),
      run: normalizeRouteIds(loaded.config.routes?.run, firstProfileId)
    };

    this.retryablePatterns =
      loaded.config.retryableErrorPatterns?.map((value) => value.toLowerCase()).filter(Boolean) ??
      DEFAULT_RETRYABLE_ERROR_PATTERNS;

    const configuredMaxAttempts = loaded.config.maxAttemptsPerJob ?? DEFAULT_MAX_ATTEMPTS_PER_JOB;
    if (!Number.isInteger(configuredMaxAttempts) || configuredMaxAttempts <= 0) {
      throw new Error("maxAttemptsPerJob must be a positive integer");
    }
    this.maxAttemptsPerJob = Math.min(configuredMaxAttempts, MAX_MAX_ATTEMPTS_PER_JOB);

    const profileSummary = [...this.profilesById.values()]
      .map((profile) => `${profile.id}(${profile.provider ?? "default"}/${profile.model ?? "default"})`)
      .join(", ");

    this.logger.log(
      `[worker] model routing source=${this.sourceLabel} profiles=${this.profilesById.size} maxAttempts=${this.maxAttemptsPerJob} ${profileSummary}`
    );
  }

  getSourceLabel(): string {
    return this.sourceLabel;
  }

  buildPlan(job: Job): ModelAttemptPlan {
    const requestedProfileId = typeof job.metadata?.modelProfile === "string" ? job.metadata.modelProfile : undefined;
    if (requestedProfileId && !this.profilesById.has(requestedProfileId)) {
      throw new Error(`Requested model profile '${requestedProfileId}' was not found`);
    }

    const selected = this.buildProfileOrder({
      kind: job.kind,
      requestedProfileId
    });

    const maxAttempts = Math.min(this.maxAttemptsPerJob, selected.length);

    return {
      profiles: selected.slice(0, maxAttempts),
      maxAttempts
    };
  }

  getSession(profileId: string, sessionKey: string): PiRpcSession {
    const profile = this.requireProfile(profileId);
    let pool = this.poolsById.get(profile.id);
    if (!pool) {
      pool = new PiRpcSessionPool({
        piBinary: this.options.piBinary,
        cwd: this.options.cwd,
        sessionRoot: this.options.sessionRoot,
        provider: profile.provider,
        model: profile.model,
        appendSystemPrompt: profile.appendSystemPrompt,
        env: profile.env
      });
      this.poolsById.set(profile.id, pool);
    }

    // Keep profile-local session dirs to avoid cross-provider session state conflicts.
    const profileSessionKey = `${profile.id}__${sessionKey}`;
    return pool.getSession(profileSessionKey);
  }

  evaluateFallback(profileId: string, input: FallbackEvaluationInput): { fallback: boolean; reason: string } {
    if (input.abortRequested) {
      return { fallback: false, reason: "abort_requested" };
    }

    if (input.attemptHadToolActivity) {
      return { fallback: false, reason: "tool_activity_detected" };
    }

    if (input.attemptHadOutput) {
      return { fallback: false, reason: "partial_output_detected" };
    }

    const retryable = this.isRetryableError(input.errorMessage);
    if (!retryable) {
      return { fallback: false, reason: "error_not_retryable" };
    }

    const profile = this.requireProfile(profileId);
    const until = Date.now() + profile.cooldownSeconds * 1000;
    this.cooldownUntilMsByProfile.set(profile.id, until);
    return { fallback: true, reason: `retryable_error_profile_cooldown_${profile.cooldownSeconds}s` };
  }

  markSuccess(profileId: string): void {
    this.cooldownUntilMsByProfile.delete(profileId);
  }

  async shutdown(): Promise<void> {
    for (const pool of this.poolsById.values()) {
      await pool.shutdown();
    }
    this.poolsById.clear();
  }

  private buildProfileOrder(options: BuildPlanOptions): ResolvedModelProfile[] {
    const requestedProfile = options.requestedProfileId
      ? this.profilesById.get(options.requestedProfileId)
      : undefined;

    let routeIds: string[];
    if (requestedProfile) {
      routeIds = [requestedProfile.id];
    } else {
      routeIds = options.kind === "run" ? this.routes.run : this.routes.task;
      if (routeIds.length === 0) {
        routeIds = this.routes.default;
      }
    }

    const validProfiles = unique(routeIds)
      .map((profileId) => this.profilesById.get(profileId))
      .filter((profile): profile is ResolvedModelProfile => Boolean(profile));

    if (validProfiles.length === 0) {
      throw new Error("No valid model profiles available for route");
    }

    const available: ResolvedModelProfile[] = [];
    const cooling: ResolvedModelProfile[] = [];
    const now = Date.now();

    for (const profile of validProfiles) {
      const until = this.cooldownUntilMsByProfile.get(profile.id) ?? 0;
      if (until > now) {
        cooling.push(profile);
      } else {
        available.push(profile);
      }
    }

    if (available.length === 0) {
      return validProfiles;
    }

    return [...available, ...cooling];
  }

  private isRetryableError(message: string): boolean {
    const normalized = message.toLowerCase();
    return this.retryablePatterns.some((pattern) => normalized.includes(pattern));
  }

  private requireProfile(profileId: string): ResolvedModelProfile {
    const profile = this.profilesById.get(profileId);
    if (!profile) {
      throw new Error(`Unknown model profile '${profileId}'`);
    }
    return profile;
  }
}

function normalizeRouteIds(ids: string[] | undefined, fallbackId: string): string[] {
  const cleaned = (ids ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  if (cleaned.length > 0) {
    return cleaned;
  }
  return [fallbackId];
}

function resolveProfile(profile: ModelProfileConfig, defaultAppendSystemPrompt: string): ResolvedModelProfile {
  if (!profile.id || profile.id.trim().length === 0) {
    throw new Error("Model profile id is required");
  }

  const cooldownSeconds = profile.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds <= 0) {
    throw new Error(`Invalid cooldownSeconds for profile '${profile.id}'`);
  }

  const env: Record<string, string> = {
    ...(profile.env ?? {})
  };

  for (const [target, sourceEnvName] of Object.entries(profile.envFrom ?? {})) {
    const value = process.env[sourceEnvName];
    if (!value) {
      throw new Error(
        `Model profile '${profile.id}' expected env var '${sourceEnvName}' for target '${target}', but it was not set`
      );
    }
    env[target] = value;
  }

  return {
    id: profile.id,
    provider: profile.provider,
    model: profile.model,
    appendSystemPrompt: profile.appendSystemPrompt ?? defaultAppendSystemPrompt,
    cooldownSeconds,
    env
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function loadRoutingConfig(options: {
  configFilePath?: string;
  requireConfigFile?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
}): { config: RoutingConfig; sourceLabel: string } {
  const explicitPath = options.configFilePath;
  const resolvedPath = explicitPath ? resolve(explicitPath) : resolve(".data/worker/model-routing.json");
  const exists = existsSync(resolvedPath);

  if (options.requireConfigFile && !exists) {
    throw new Error(`PI_MODEL_ROUTING_FILE was set but file does not exist: ${resolvedPath}`);
  }

  if (exists) {
    const raw = readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as RoutingConfig;
    validateRoutingConfig(parsed, resolvedPath);
    return {
      config: parsed,
      sourceLabel: `file:${resolvedPath}`
    };
  }

  const fallbackProfile: ModelProfileConfig = {
    id: "default",
    provider: options.defaultProvider,
    model: options.defaultModel,
    cooldownSeconds: DEFAULT_COOLDOWN_SECONDS
  };

  return {
    config: {
      profiles: [fallbackProfile],
      routes: {
        default: [fallbackProfile.id],
        task: [fallbackProfile.id],
        run: [fallbackProfile.id]
      },
      maxAttemptsPerJob: 1,
      retryableErrorPatterns: DEFAULT_RETRYABLE_ERROR_PATTERNS
    },
    sourceLabel: "legacy-env"
  };
}

function validateRoutingConfig(config: RoutingConfig, fileLabel: string): void {
  if (!config || typeof config !== "object") {
    throw new Error(`Invalid model routing config in ${fileLabel}`);
  }

  if (!Array.isArray(config.profiles) || config.profiles.length === 0) {
    throw new Error(`Model routing config in ${fileLabel} must define non-empty 'profiles'`);
  }

  const profileIds = new Set<string>();
  for (const profile of config.profiles) {
    if (!profile || typeof profile !== "object") {
      throw new Error(`Invalid profile entry in ${fileLabel}`);
    }

    if (typeof profile.id !== "string" || profile.id.trim().length === 0) {
      throw new Error(`Profile id must be a non-empty string in ${fileLabel}`);
    }
    if (profileIds.has(profile.id)) {
      throw new Error(`Duplicate profile id '${profile.id}' in ${fileLabel}`);
    }
    profileIds.add(profile.id);

    if (profile.provider !== undefined && typeof profile.provider !== "string") {
      throw new Error(`Profile '${profile.id}' provider must be a string in ${fileLabel}`);
    }

    if (profile.model !== undefined && typeof profile.model !== "string") {
      throw new Error(`Profile '${profile.id}' model must be a string in ${fileLabel}`);
    }

    if (profile.cooldownSeconds !== undefined && !Number.isInteger(profile.cooldownSeconds)) {
      throw new Error(`Profile '${profile.id}' cooldownSeconds must be an integer in ${fileLabel}`);
    }

    if (profile.env !== undefined && !isStringRecord(profile.env)) {
      throw new Error(`Profile '${profile.id}' env must be an object of string values in ${fileLabel}`);
    }

    if (profile.envFrom !== undefined && !isStringRecord(profile.envFrom)) {
      throw new Error(`Profile '${profile.id}' envFrom must be an object of string values in ${fileLabel}`);
    }
  }

  if (config.routes !== undefined) {
    if (typeof config.routes !== "object" || config.routes === null) {
      throw new Error(`Model routing routes must be an object in ${fileLabel}`);
    }

    for (const [key, value] of Object.entries(config.routes)) {
      if (value !== undefined && !Array.isArray(value)) {
        throw new Error(`Model routing routes.${key} must be an array in ${fileLabel}`);
      }
      if (Array.isArray(value)) {
        for (const routeId of value) {
          if (typeof routeId !== "string" || routeId.trim().length === 0) {
            throw new Error(`Model routing routes.${key} entries must be non-empty strings in ${fileLabel}`);
          }
          if (!profileIds.has(routeId)) {
            throw new Error(`Model routing routes.${key} references unknown profile '${routeId}' in ${fileLabel}`);
          }
        }
      }
    }
  }

  if (config.maxAttemptsPerJob !== undefined && !Number.isInteger(config.maxAttemptsPerJob)) {
    throw new Error(`maxAttemptsPerJob must be an integer in ${fileLabel}`);
  }

  if (
    config.retryableErrorPatterns !== undefined &&
    (!Array.isArray(config.retryableErrorPatterns) ||
      config.retryableErrorPatterns.some((value) => typeof value !== "string"))
  ) {
    throw new Error(`retryableErrorPatterns must be an array of strings in ${fileLabel}`);
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  for (const entry of Object.values(value)) {
    if (typeof entry !== "string") {
      return false;
    }
  }

  return true;
}
