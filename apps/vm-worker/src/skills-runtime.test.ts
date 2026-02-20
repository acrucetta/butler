import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverSkills, loadSkillsConfig, resolveSkillsContext } from "./skills-runtime.js";

function writeSkill(root: string, id: string, skillMd: string, manifest?: Record<string, unknown>): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd, "utf8");
  if (manifest) {
    writeFileSync(join(dir, "skill.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

test("discoverSkills reads a single local skills directory", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-skills-"));
  try {
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });

    writeSkill(skillsDir, "gmail", "gmail instructions", { id: "gmail", description: "gmail skill" });
    const skills = discoverSkills(root);

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.id, "gmail");
    assert.equal(skills[0]?.description, "gmail skill");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSkillsContext selects enabled skills automatically", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-skills-"));
  try {
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeSkill(skillsDir, "google-calendar", "Use for meeting schedule and event planning", {
      id: "google-calendar",
      name: "Google Calendar",
      tags: ["calendar", "meetings"]
    });
    writeSkill(skillsDir, "whoop", "Use for recovery and strain trends", {
      id: "whoop",
      name: "Whoop",
      tags: ["fitness", "recovery"]
    });

    const autoContext = resolveSkillsContext({
      userPrompt: "Check my calendar meetings tomorrow",
      workspaceRoot: root,
      config: {
        mode: "auto",
        contextWindow: 2,
        maxChars: 4000,
        enabledSkills: ["google-calendar", "whoop"]
      }
    });

    assert.equal(autoContext.selected.length, 1);
    assert.equal(autoContext.selected[0]?.id, "google-calendar");
    assert.match(autoContext.context, /Google Calendar/);

    const offContext = resolveSkillsContext({
      userPrompt: "Check my calendar meetings tomorrow",
      workspaceRoot: root,
      config: {
        mode: "off",
        contextWindow: 2,
        maxChars: 4000,
        enabledSkills: ["google-calendar", "whoop"]
      }
    });

    assert.equal(offContext.selected.length, 0);
    assert.equal(offContext.context, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadSkillsConfig merges enabledSkills and manual alias", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-skills-"));
  try {
    const configPath = join(root, "skills.json");
    const defaults = loadSkillsConfig(join(root, "missing.json"));
    assert.equal(defaults.mode, "auto");
    assert.deepEqual(defaults.enabledSkills, []);

    writeFileSync(
      configPath,
      `${JSON.stringify({ mode: "manual", enabledSkills: ["Whoop"], contextWindow: 7 }, null, 2)}\n`,
      "utf8"
    );

    const loaded = loadSkillsConfig(configPath);
    assert.equal(loaded.mode, "always");
    assert.equal(loaded.contextWindow, 7);
    assert.deepEqual(loaded.enabledSkills, ["whoop"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
