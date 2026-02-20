import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const DEFAULT_SKILLS_DIR = "skills";
export const DEFAULT_SKILLS_CONFIG_PATH = ".data/skills/config.json";
export const DEFAULT_SKILLS_OUTPUT_DIR = ".data/skills";

export function defaultSkillsConfig() {
  return {
    mode: "auto",
    contextWindow: 4,
    maxChars: 12000,
    enabledSkills: []
  };
}

export function loadSkillsConfig(configPath) {
  const defaults = defaultSkillsConfig();
  if (!existsSync(configPath)) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));

    return {
      mode: parseMode(parsed.mode) ?? defaults.mode,
      contextWindow: parsePositiveInt(parsed.contextWindow, defaults.contextWindow),
      maxChars: parsePositiveInt(parsed.maxChars, defaults.maxChars),
      enabledSkills: Array.isArray(parsed.enabledSkills)
        ? parsed.enabledSkills
            .filter((value) => typeof value === "string")
            .map((value) => normalizeSkillId(value))
            .filter(Boolean)
        : defaults.enabledSkills
    };
  } catch {
    return defaults;
  }
}

export function saveSkillsConfig(configPath, config) {
  mkdirSync(dirname(configPath), { recursive: true });
  const uniqueEnabled = Array.from(new Set((config.enabledSkills ?? []).map((id) => normalizeSkillId(id)).filter(Boolean)));
  const normalized = {
    mode: parseMode(config.mode) ?? "auto",
    contextWindow: parsePositiveInt(config.contextWindow, 4),
    maxChars: parsePositiveInt(config.maxChars, 12000),
    enabledSkills: uniqueEnabled
  };

  writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function enableSkill(configPath, skillId) {
  const config = loadSkillsConfig(configPath);
  const normalized = normalizeSkillId(skillId);
  if (!config.enabledSkills.includes(normalized)) {
    config.enabledSkills.push(normalized);
  }
  saveSkillsConfig(configPath, config);
  return config;
}

export function disableSkill(configPath, skillId) {
  const config = loadSkillsConfig(configPath);
  const normalized = normalizeSkillId(skillId);
  config.enabledSkills = config.enabledSkills.filter((id) => id !== normalized);
  saveSkillsConfig(configPath, config);
  return config;
}

export function discoverSkills(options) {
  const workspaceRoot = resolve(options.workspaceRoot);
  const root = resolve(options.skillsDir ?? resolve(workspaceRoot, DEFAULT_SKILLS_DIR));

  if (!existsSync(root)) {
    return [];
  }

  const skills = [];
  const children = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name));

  for (const child of children) {
    const skill = readSkill(child);
    if (skill) {
      skills.push(skill);
    }
  }

  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveEnabledSkills(skills, config) {
  const enabled = new Set((config.enabledSkills ?? []).map((id) => normalizeSkillId(id)));
  return skills.filter((skill) => enabled.has(skill.id));
}

export function mergeEnabledSkillsIntoMcp({ baseMcporter, baseTargets, enabledSkills }) {
  const mergedServers = {
    ...(isRecord(baseMcporter?.mcpServers) ? baseMcporter.mcpServers : {})
  };
  const mergedTargets = [...baseTargets];

  const seenTargetNames = new Set(mergedTargets.map((target) => target.name));

  for (const skill of enabledSkills) {
    for (const [serverName, serverConfig] of Object.entries(skill.tools.mcpServers)) {
      if (mergedServers[serverName]) {
        throw new Error(`skills sync: duplicate MCP server name '${serverName}' from skill '${skill.id}'`);
      }
      mergedServers[serverName] = serverConfig;
    }

    for (const target of skill.tools.targets) {
      if (seenTargetNames.has(target.name)) {
        throw new Error(`skills sync: duplicate MCP target name '${target.name}' from skill '${skill.id}'`);
      }
      seenTargetNames.add(target.name);
      mergedTargets.push({
        name: target.name,
        selector: target.selector ?? target.name,
        emitTypes: target.emitTypes !== false,
        timeoutMs: parsePositiveInt(target.timeoutMs, 120000)
      });
    }
  }

  return {
    mcporter: {
      ...baseMcporter,
      mcpServers: mergedServers
    },
    targets: mergedTargets
  };
}

export function writeSkillScaffold({ id, workspaceRoot, skillsDir }) {
  const normalizedId = normalizeSkillId(id);
  if (!normalizedId) {
    throw new Error("skills scaffold: skill id is required");
  }

  const root = resolve(skillsDir ?? resolve(workspaceRoot, DEFAULT_SKILLS_DIR));
  const skillDir = resolve(root, normalizedId);
  if (existsSync(skillDir)) {
    throw new Error(`skills scaffold: ${skillDir} already exists`);
  }

  mkdirSync(skillDir, { recursive: true });

  const manifest = {
    id: normalizedId,
    name: normalizedId,
    description: "Describe what this skill does.",
    tags: [],
    env: [],
    tools: {
      mcpServers: {},
      targets: []
    }
  };

  const skillMarkdown = [
    `# ${normalizedId}`,
    "",
    "## Purpose",
    "Describe when the agent should use this skill.",
    "",
    "## Capabilities",
    "- Add concrete capabilities here.",
    "",
    "## Constraints",
    "- Add safety, auth, and side-effect constraints here.",
    "",
    "## Setup",
    "- Add env vars and setup instructions.",
    ""
  ].join("\n");

  writeFileSync(resolve(skillDir, "skill.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(resolve(skillDir, "SKILL.md"), skillMarkdown, "utf8");

  return skillDir;
}

function readSkill(directory) {
  const skillPath = resolve(directory, "SKILL.md");
  if (!existsSync(skillPath)) {
    return null;
  }

  const instructions = readFileSync(skillPath, "utf8").trim();
  if (instructions.length === 0) {
    return null;
  }

  let manifest = {};
  const manifestPath = resolve(directory, "skill.json");
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (isRecord(parsed)) {
        manifest = parsed;
      }
    } catch {
      // Ignore malformed manifests so SKILL.md still works.
    }
  }

  const id = normalizeSkillId(
    typeof manifest.id === "string" && manifest.id.trim().length > 0 ? manifest.id : basename(directory)
  );
  if (!id) {
    return null;
  }

  const tools = readSkillTools(manifest.tools);

  return {
    id,
    name: typeof manifest.name === "string" && manifest.name.trim().length > 0 ? manifest.name.trim() : id,
    description: typeof manifest.description === "string" ? manifest.description.trim() : "",
    tags: Array.isArray(manifest.tags)
      ? manifest.tags.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean)
      : [],
    env: Array.isArray(manifest.env)
      ? manifest.env.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean)
      : [],
    directory,
    instructions,
    tools
  };
}

function readSkillTools(value) {
  const tools = {
    mcpServers: {},
    targets: []
  };

  if (!isRecord(value)) {
    return tools;
  }

  if (isRecord(value.mcpServers)) {
    for (const [name, server] of Object.entries(value.mcpServers)) {
      if (!isRecord(server) || typeof server.command !== "string") {
        continue;
      }

      tools.mcpServers[name] = {
        description: typeof server.description === "string" ? server.description : undefined,
        command: server.command,
        args: Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === "string") : undefined,
        env: isRecord(server.env)
          ? Object.fromEntries(Object.entries(server.env).filter((entry) => typeof entry[1] === "string"))
          : undefined
      };
    }
  }

  if (Array.isArray(value.targets)) {
    for (const target of value.targets) {
      if (!isRecord(target) || typeof target.name !== "string") {
        continue;
      }
      tools.targets.push({
        name: target.name,
        selector: typeof target.selector === "string" && target.selector.trim().length > 0 ? target.selector : target.name,
        emitTypes: target.emitTypes !== false,
        timeoutMs: parsePositiveInt(target.timeoutMs, 120000)
      });
    }
  }

  return tools;
}

function parseMode(value) {
  if (value === "auto" || value === "always" || value === "off") {
    return value;
  }
  if (value === "manual") {
    return "always";
  }
  return null;
}

function parsePositiveInt(value, fallback) {
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

function normalizeSkillId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
