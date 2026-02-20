import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export type SkillsMode = "auto" | "always" | "off";

export interface SkillMcpServer {
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SkillMcpTarget {
  name: string;
  selector: string;
  emitTypes: boolean;
  timeoutMs: number;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  tags: string[];
  env: string[];
  instructions: string;
  directory: string;
  tools: {
    mcpServers: Record<string, SkillMcpServer>;
    targets: SkillMcpTarget[];
  };
}

export interface SkillsConfig {
  mode: SkillsMode;
  contextWindow: number;
  maxChars: number;
  enabledSkills: string[];
}

export interface ResolveSkillsContextOptions {
  userPrompt: string;
  workspaceRoot: string;
  skillsDir?: string;
  config?: SkillsConfig;
  configPath?: string;
  modeOverride?: SkillsMode;
  contextWindowOverride?: number;
  maxCharsOverride?: number;
}

export interface SkillsContextResult {
  discovered: SkillManifest[];
  enabled: SkillManifest[];
  selected: SkillManifest[];
  mode: SkillsMode;
  context: string;
}

export function defaultSkillsConfig(): SkillsConfig {
  return {
    mode: "auto",
    contextWindow: 4,
    maxChars: 12_000,
    enabledSkills: []
  };
}

export function loadSkillsConfig(configPath: string): SkillsConfig {
  const defaults = defaultSkillsConfig();
  if (!existsSync(configPath)) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return {
      mode: parseSkillsMode(parsed.mode) ?? defaults.mode,
      contextWindow: parsePositiveInt(parsed.contextWindow, defaults.contextWindow),
      maxChars: parsePositiveInt(parsed.maxChars, defaults.maxChars),
      enabledSkills: Array.isArray(parsed.enabledSkills)
        ? parsed.enabledSkills
            .filter((value): value is string => typeof value === "string")
            .map((value) => normalizeSkillId(value))
            .filter((value) => value.length > 0)
        : defaults.enabledSkills
    };
  } catch {
    return defaults;
  }
}

export function discoverSkills(workspaceRoot: string, skillsDir?: string): SkillManifest[] {
  const root = resolve(skillsDir ?? resolve(workspaceRoot, "skills"));
  if (!existsSync(root)) {
    return [];
  }

  const manifests: SkillManifest[] = [];
  const children = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name));

  for (const directory of children) {
    const parsed = readSkill(directory);
    if (parsed) {
      manifests.push(parsed);
    }
  }

  manifests.sort((left, right) => left.id.localeCompare(right.id));
  return manifests;
}

export function resolveSkillsContext(options: ResolveSkillsContextOptions): SkillsContextResult {
  const config = {
    ...(options.config ?? loadSkillsConfig(resolve(options.configPath ?? resolve(options.workspaceRoot, ".data/skills/config.json"))))
  };

  if (options.modeOverride) {
    config.mode = options.modeOverride;
  }
  if (options.contextWindowOverride && options.contextWindowOverride > 0) {
    config.contextWindow = options.contextWindowOverride;
  }
  if (options.maxCharsOverride && options.maxCharsOverride > 0) {
    config.maxChars = options.maxCharsOverride;
  }

  const discovered = discoverSkills(options.workspaceRoot, options.skillsDir);
  const enabledIds = new Set(config.enabledSkills.map((value) => normalizeSkillId(value)));
  const enabled = discovered.filter((skill) => enabledIds.has(skill.id));
  const selected = selectSkillsForPrompt(options.userPrompt, enabled, config.mode, config.contextWindow);
  const context = formatSkillsContext(selected, config.maxChars);

  return {
    discovered,
    enabled,
    selected,
    mode: config.mode,
    context
  };
}

export function selectSkillsForPrompt(
  userPrompt: string,
  skills: SkillManifest[],
  mode: SkillsMode,
  contextWindow: number
): SkillManifest[] {
  const limit = Math.max(1, contextWindow);
  if (mode === "off") {
    return [];
  }

  if (mode === "always") {
    return skills.slice(0, limit);
  }

  const scored = skills
    .map((skill) => ({ skill, score: scoreSkill(userPrompt, skill) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.skill.id.localeCompare(right.skill.id);
    });

  return scored.slice(0, limit).map((entry) => entry.skill);
}

export function parseSkillsMode(value: unknown): SkillsMode | null {
  if (value === "auto" || value === "always" || value === "off") {
    return value;
  }
  if (value === "manual") {
    return "always";
  }
  return null;
}

function readSkill(directory: string): SkillManifest | null {
  const skillPath = resolve(directory, "SKILL.md");
  if (!existsSync(skillPath)) {
    return null;
  }

  const rawInstructions = readFileSync(skillPath, "utf8").trim();
  if (rawInstructions.length === 0) {
    return null;
  }

  const manifestPath = resolve(directory, "skill.json");
  let manifest: Record<string, unknown> = {};
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (isRecord(parsed)) {
        manifest = parsed;
      }
    } catch {
      // Ignore malformed manifests; load SKILL.md by folder name.
    }
  }

  const id = normalizeSkillId(typeof manifest.id === "string" && manifest.id.trim().length > 0 ? manifest.id : basename(directory));
  const tags = Array.isArray(manifest.tags)
    ? manifest.tags.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : [];
  const env = Array.isArray(manifest.env)
    ? manifest.env.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : [];

  return {
    id,
    name: typeof manifest.name === "string" && manifest.name.trim().length > 0 ? manifest.name.trim() : id,
    description: typeof manifest.description === "string" ? manifest.description.trim() : "",
    tags,
    env,
    instructions: rawInstructions,
    directory,
    tools: parseTools(manifest.tools)
  };
}

function parseTools(value: unknown): SkillManifest["tools"] {
  const empty = { mcpServers: {}, targets: [] as SkillMcpTarget[] };
  if (!isRecord(value)) {
    return empty;
  }

  const mcpServers: Record<string, SkillMcpServer> = {};
  if (isRecord(value.mcpServers)) {
    for (const [name, raw] of Object.entries(value.mcpServers)) {
      if (!isRecord(raw) || typeof raw.command !== "string") {
        continue;
      }

      mcpServers[name] = {
        description: typeof raw.description === "string" ? raw.description : undefined,
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : undefined,
        env: isRecord(raw.env)
          ? Object.fromEntries(
              Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
            )
          : undefined
      };
    }
  }

  const targets: SkillMcpTarget[] = [];
  if (Array.isArray(value.targets)) {
    for (const raw of value.targets) {
      if (!isRecord(raw) || typeof raw.name !== "string") {
        continue;
      }

      targets.push({
        name: raw.name,
        selector: typeof raw.selector === "string" && raw.selector.trim().length > 0 ? raw.selector : raw.name,
        emitTypes: raw.emitTypes !== false,
        timeoutMs: parsePositiveInt(raw.timeoutMs, 120_000)
      });
    }
  }

  return { mcpServers, targets };
}

function normalizeSkillId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function formatSkillsContext(skills: SkillManifest[], maxChars: number): string {
  if (skills.length === 0) {
    return "";
  }

  const budget = Math.max(500, maxChars);
  const sections: string[] = [
    "Skills snapshot.",
    "Use only the skills relevant to the user request.",
    ""
  ];

  for (const skill of skills) {
    const body = [
      `### ${skill.name} (${skill.id})`,
      skill.description.length > 0 ? skill.description : "",
      skill.tags.length > 0 ? `tags: ${skill.tags.join(", ")}` : "",
      skill.instructions
    ]
      .filter((line) => line.length > 0)
      .join("\n");

    const next = `${body}\n`;
    const candidate = `${sections.join("\n")}\n${next}`;
    if (candidate.length > budget) {
      sections.push("[skills context truncated due to maxChars]");
      break;
    }

    sections.push(next);
  }

  return sections.join("\n").trim();
}

function scoreSkill(prompt: string, skill: SkillManifest): number {
  const promptLower = prompt.toLowerCase();
  const terms = tokenize(promptLower);
  if (terms.length === 0) {
    return 0;
  }

  const haystack = [
    skill.id,
    skill.name,
    skill.description,
    skill.tags.join(" "),
    skill.instructions.slice(0, 4_000)
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;

  if (promptLower.includes(skill.id.toLowerCase())) {
    score += 5;
  }

  for (const tag of skill.tags) {
    if (promptLower.includes(tag.toLowerCase())) {
      score += 3;
    }
  }

  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length >= 7 ? 2 : 1;
    }
  }

  return score;
}

function tokenize(value: string): string[] {
  const seen = new Set<string>();
  const parts = value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);

  for (const part of parts) {
    seen.add(part);
  }

  return Array.from(seen);
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
