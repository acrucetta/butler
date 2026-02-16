import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JobKind } from "@pi-self/contracts";

interface ToolPolicyRuleConfig {
  allow?: string[];
  deny?: string[];
}

interface ToolPolicyConfig {
  default?: ToolPolicyRuleConfig;
  byKind?: {
    task?: ToolPolicyRuleConfig;
    run?: ToolPolicyRuleConfig;
  };
  byProfile?: Record<string, ToolPolicyRuleConfig>;
}

interface ResolvedToolPolicy {
  allow: string[] | null;
  deny: string[];
}

export interface ToolPolicyContext {
  kind: JobKind;
  profileId: string;
  allow: string[] | null;
  deny: string[];
  evaluateTool(toolName: string): ToolDecision;
}

export interface ToolDecision {
  allowed: boolean;
  reason: string;
  matchedDenyPattern?: string;
}

interface RuntimeOptions {
  configFilePath?: string;
  requireConfigFile?: boolean;
  logger?: Pick<Console, "log">;
}

const DEFAULT_POLICY: ToolPolicyConfig = {};

export class ToolPolicyRuntime {
  private readonly config: ToolPolicyConfig;
  private readonly sourceLabel: string;
  private readonly logger: Pick<Console, "log">;

  constructor(options: RuntimeOptions) {
    this.logger = options.logger ?? console;
    const loaded = loadToolPolicyConfig({
      configFilePath: options.configFilePath,
      requireConfigFile: options.requireConfigFile
    });

    this.config = loaded.config;
    this.sourceLabel = loaded.sourceLabel;
    this.logger.log(`[worker] tool policy source=${this.sourceLabel}`);
  }

  getSourceLabel(): string {
    return this.sourceLabel;
  }

  resolveContext(kind: JobKind, profileId: string): ToolPolicyContext {
    const resolved = resolvePolicy(this.config, kind, profileId);
    return {
      kind,
      profileId,
      allow: resolved.allow ? [...resolved.allow] : null,
      deny: [...resolved.deny],
      evaluateTool: (toolName) => evaluateToolName(toolName, resolved)
    };
  }
}

function resolvePolicy(config: ToolPolicyConfig, kind: JobKind, profileId: string): ResolvedToolPolicy {
  const merged: ResolvedToolPolicy = {
    allow: null,
    deny: []
  };

  applyRule(merged, config.default);
  applyRule(merged, config.byKind?.[kind]);
  applyRule(merged, config.byProfile?.[profileId]);

  return merged;
}

function applyRule(target: ResolvedToolPolicy, rule: ToolPolicyRuleConfig | undefined): void {
  if (!rule) {
    return;
  }

  if (rule.allow !== undefined) {
    target.allow = normalizePatterns(rule.allow);
  }

  if (rule.deny !== undefined) {
    target.deny = [...target.deny, ...normalizePatterns(rule.deny)];
  }
}

function evaluateToolName(toolName: string, policy: ResolvedToolPolicy): ToolDecision {
  for (const denyPattern of policy.deny) {
    if (matchesPattern(toolName, denyPattern)) {
      return {
        allowed: false,
        reason: "matched_deny_rule",
        matchedDenyPattern: denyPattern
      };
    }
  }

  if (policy.allow && policy.allow.length > 0 && !policy.allow.some((allowPattern) => matchesPattern(toolName, allowPattern))) {
    return {
      allowed: false,
      reason: "not_in_allowlist"
    };
  }

  if (policy.allow && policy.allow.length === 0) {
    return {
      allowed: false,
      reason: "allowlist_empty"
    };
  }

  return {
    allowed: true,
    reason: "allowed"
  };
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (!pattern.includes("*")) {
    return value === pattern;
  }

  const regex = globPatternToRegExp(pattern);
  return regex.test(value);
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexSource = `^${escaped.replace(/\*/g, ".*")}$`;
  return new RegExp(regexSource);
}

function normalizePatterns(patterns: string[]): string[] {
  return patterns
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function loadToolPolicyConfig(options: {
  configFilePath?: string;
  requireConfigFile?: boolean;
}): { config: ToolPolicyConfig; sourceLabel: string } {
  const explicitPath = options.configFilePath;
  const resolvedPath = explicitPath ? resolve(explicitPath) : resolve(".data/worker/tool-policy.json");
  const exists = existsSync(resolvedPath);

  if (options.requireConfigFile && !exists) {
    throw new Error(`PI_TOOL_POLICY_FILE was set but file does not exist: ${resolvedPath}`);
  }

  if (exists) {
    const raw = readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as ToolPolicyConfig;
    validateToolPolicyConfig(parsed, resolvedPath);
    return {
      config: parsed,
      sourceLabel: `file:${resolvedPath}`
    };
  }

  return {
    config: DEFAULT_POLICY,
    sourceLabel: "default-allow-all"
  };
}

function validateToolPolicyConfig(config: ToolPolicyConfig, fileLabel: string): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid tool policy config in ${fileLabel}`);
  }

  validateRule(config.default, "default", fileLabel);

  if (config.byKind !== undefined) {
    if (!config.byKind || typeof config.byKind !== "object" || Array.isArray(config.byKind)) {
      throw new Error(`Tool policy byKind must be an object in ${fileLabel}`);
    }
    validateRule(config.byKind.task, "byKind.task", fileLabel);
    validateRule(config.byKind.run, "byKind.run", fileLabel);
  }

  if (config.byProfile !== undefined) {
    if (!config.byProfile || typeof config.byProfile !== "object" || Array.isArray(config.byProfile)) {
      throw new Error(`Tool policy byProfile must be an object in ${fileLabel}`);
    }
    for (const [profileId, rule] of Object.entries(config.byProfile)) {
      if (profileId.trim().length === 0) {
        throw new Error(`Tool policy byProfile key must be non-empty in ${fileLabel}`);
      }
      validateRule(rule, `byProfile.${profileId}`, fileLabel);
    }
  }
}

function validateRule(rule: ToolPolicyRuleConfig | undefined, fieldLabel: string, fileLabel: string): void {
  if (rule === undefined) {
    return;
  }
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new Error(`Tool policy ${fieldLabel} must be an object in ${fileLabel}`);
  }
  if (rule.allow !== undefined) {
    validateStringArray(rule.allow, `${fieldLabel}.allow`, fileLabel);
  }
  if (rule.deny !== undefined) {
    validateStringArray(rule.deny, `${fieldLabel}.deny`, fileLabel);
  }
}

function validateStringArray(value: unknown, fieldLabel: string, fileLabel: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`Tool policy ${fieldLabel} must be an array in ${fileLabel}`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`Tool policy ${fieldLabel} entries must be strings in ${fileLabel}`);
    }
  }
}
