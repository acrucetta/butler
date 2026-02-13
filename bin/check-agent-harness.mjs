#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const requiredFiles = [
  "AGENTS.md",
  "docs/ARCHITECTURE.md",
  "docs/PLANS.md",
  "docs/QUALITY_SCORE.md",
  "docs/RELIABILITY.md",
  "docs/SECURITY.md",
  "docs/PRODUCT_SENSE.md",
  "docs/exec-plans/PLAN_TEMPLATE.md",
  "docs/design-docs/index.md",
  "docs/product-specs/index.md",
  "docs/references/openai-agent-harness-best-practices.md",
  ".agents/skills/spec-driven-execution/SKILL.md"
];

const requiredHeadings = new Map([
  [
    "docs/exec-plans/PLAN_TEMPLATE.md",
    [
      "Problem statement",
      "Scope",
      "Non-goals",
      "Constraints",
      "Interfaces and contracts affected",
      "Acceptance criteria",
      "Verification commands"
    ]
  ],
  [
    "docs/PLANS.md",
    ["Execution Plan Lifecycle", "Required Plan Sections", "Plan States", "Operator Commands"]
  ],
  ["docs/QUALITY_SCORE.md", ["Scoring Model", "Current Scorecard", "Update Rules"]],
  ["docs/RELIABILITY.md", ["Reliability Targets", "Failure Modes", "Operational Checks"]],
  ["docs/SECURITY.md", ["Assets and Boundaries", "Required Controls", "Security Review Triggers"]],
  ["docs/PRODUCT_SENSE.md", ["Core Users", "High-value Flows", "Non-goals"]],
  ["docs/design-docs/index.md", ["Current Design Docs", "Authoring Rules"]],
  ["docs/product-specs/index.md", ["Product Specs", "Authoring Rules"]]
]);

const requiredAgentsMapEntries = [
  "docs/PLANS.md",
  "docs/exec-plans/PLAN_TEMPLATE.md",
  "docs/QUALITY_SCORE.md",
  "docs/RELIABILITY.md",
  "docs/SECURITY.md",
  "docs/PRODUCT_SENSE.md",
  "docs/references/openai-agent-harness-best-practices.md",
  ".agents/skills/spec-driven-execution/SKILL.md"
];

const issues = [];
let checkedFiles = 0;

for (const filePath of requiredFiles) {
  if (!existsSync(filePath)) {
    issues.push(`missing required file: ${filePath}`);
    continue;
  }
  checkedFiles += 1;
}

for (const [filePath, headings] of requiredHeadings.entries()) {
  if (!existsSync(filePath)) {
    continue;
  }

  const content = readFileSync(filePath, "utf8");
  for (const heading of headings) {
    if (!content.includes(`## ${heading}`)) {
      issues.push(`${filePath} is missing heading: ## ${heading}`);
    }
  }
}

if (existsSync("AGENTS.md")) {
  const agents = readFileSync("AGENTS.md", "utf8");
  const lineCount = agents.split(/\r?\n/).length;
  if (lineCount > 220) {
    issues.push(`AGENTS.md is too long (${lineCount} lines). Keep it concise and map-like.`);
  }

  if (!agents.includes("## Map")) {
    issues.push("AGENTS.md must include a ## Map section.");
  }

  for (const pathEntry of requiredAgentsMapEntries) {
    if (!agents.includes(pathEntry)) {
      issues.push(`AGENTS.md map is missing reference: ${pathEntry}`);
    }
  }
}

const completedPlansDir = "docs/exec-plans/completed";
if (!existsSync(completedPlansDir)) {
  issues.push("missing required directory: docs/exec-plans/completed");
} else {
  const completedPlans = readdirSync(completedPlansDir).filter((name) => name.endsWith(".md"));
  if (completedPlans.length === 0) {
    issues.push("docs/exec-plans/completed must contain at least one completed plan.");
  } else {
    const mostRecentPlan = completedPlans
      .map((name) => join(completedPlansDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    const content = readFileSync(mostRecentPlan, "utf8");
    for (const heading of ["## Problem statement", "## Acceptance criteria", "## Verification commands", "## Result"]) {
      if (!content.includes(heading)) {
        issues.push(`${mostRecentPlan} is missing required section: ${heading}`);
      }
    }
  }
}

const refsPath = "docs/references/openai-agent-harness-best-practices.md";
if (existsSync(refsPath)) {
  const refs = readFileSync(refsPath, "utf8");
  if (!refs.includes("https://openai.com/")) {
    issues.push(`${refsPath} must include at least one openai.com citation.`);
  }
  if (!refs.includes("https://developers.openai.com/")) {
    issues.push(`${refsPath} must include at least one developers.openai.com citation.`);
  }
}

if (issues.length > 0) {
  console.error("harness-check: failed");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`harness-check: ok (${checkedFiles} required files present)`);
