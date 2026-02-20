import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  defaultSkillsConfig,
  discoverSkills,
  disableSkill,
  enableSkill,
  loadSkillsConfig,
  mergeEnabledSkillsIntoMcp
} from "./skills-lib.mjs";

function withTempDir(fn) {
  const root = mkdtempSync(resolve(tmpdir(), "butler-skills-lib-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("enableSkill and disableSkill mutate enabledSkills list", () => {
  withTempDir((root) => {
    const configPath = resolve(root, "config.json");

    const defaults = loadSkillsConfig(configPath);
    assert.deepEqual(defaults, defaultSkillsConfig());

    enableSkill(configPath, "Whoop");
    enableSkill(configPath, "whoop");
    enableSkill(configPath, "google-calendar");
    let next = loadSkillsConfig(configPath);
    assert.deepEqual(next.enabledSkills, ["whoop", "google-calendar"]);

    disableSkill(configPath, "whoop");
    next = loadSkillsConfig(configPath);
    assert.deepEqual(next.enabledSkills, ["google-calendar"]);
  });
});

test("discoverSkills reads local skills directory manifests", () => {
  withTempDir((root) => {
    const skillsDir = resolve(root, "skills");
    const whoopDir = resolve(skillsDir, "whoop");
    mkdirSync(whoopDir, { recursive: true });
    writeFileSync(
      resolve(whoopDir, "skill.json"),
      `${JSON.stringify(
        {
          id: "whoop",
          name: "Whoop",
          description: "Recovery and strain trends",
          tags: ["fitness"],
          env: ["WHOOP_CLIENT_ID"]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    writeFileSync(resolve(whoopDir, "SKILL.md"), "# Whoop\n\nUse Whoop metrics.\n", "utf8");

    const discovered = discoverSkills({ workspaceRoot: root, skillsDir });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.id, "whoop");
    assert.equal(discovered[0]?.name, "Whoop");
    assert.equal(discovered[0]?.description, "Recovery and strain trends");
    assert.deepEqual(discovered[0]?.env, ["WHOOP_CLIENT_ID"]);
  });
});

test("mergeEnabledSkillsIntoMcp merges skill servers and targets", () => {
  const merged = mergeEnabledSkillsIntoMcp({
    baseMcporter: {
      mcpServers: {
        codex: { command: "codex", args: ["mcp-server"] }
      }
    },
    baseTargets: [{ name: "codex", selector: "codex", emitTypes: true, timeoutMs: 120000 }],
    enabledSkills: [
      {
        id: "whoop",
        tools: {
          mcpServers: {
            whoop: {
              command: "npx",
              args: ["-y", "@example/mcp-whoop"]
            }
          },
          targets: [{ name: "whoop", selector: "whoop", emitTypes: true, timeoutMs: 120000 }]
        }
      }
    ]
  });

  assert.equal(merged.mcporter.mcpServers.whoop.command, "npx");
  assert.equal(merged.targets.length, 2);
  assert.equal(merged.targets[1]?.name, "whoop");
});

test("mergeEnabledSkillsIntoMcp rejects duplicate target names", () => {
  assert.throws(
    () =>
      mergeEnabledSkillsIntoMcp({
        baseMcporter: { mcpServers: {} },
        baseTargets: [{ name: "codex", selector: "codex", emitTypes: true, timeoutMs: 120000 }],
        enabledSkills: [
          {
            id: "duplicate",
            tools: {
              mcpServers: {},
              targets: [{ name: "codex", selector: "codex", emitTypes: true, timeoutMs: 120000 }]
            }
          }
        ]
      }),
    /duplicate MCP target name/
  );
});

test("enableSkill writes normalized config JSON", () => {
  withTempDir((root) => {
    const configPath = resolve(root, "config.json");
    enableSkill(configPath, "Google Calendar");
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);

    assert.equal(parsed.mode, "auto");
    assert.equal(parsed.contextWindow, 4);
    assert.deepEqual(parsed.enabledSkills, ["google-calendar"]);
  });
});
