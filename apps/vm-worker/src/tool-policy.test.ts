import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { ToolPolicyRuntime } from "./tool-policy.js";

function writeConfig(config: unknown): string {
  const dir = mkdtempSync(resolve(tmpdir(), "butler-tool-policy-test-"));
  const filePath = resolve(dir, "tool-policy.json");
  writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
  return filePath;
}

test("defaults to allow-all when policy file is not present", () => {
  const runtime = new ToolPolicyRuntime({
    configFilePath: resolve(tmpdir(), `missing-${Date.now()}-${Math.random()}.json`)
  });
  const context = runtime.resolveContext("task", "primary");
  assert.equal(context.evaluateTool("run_shell_command").allowed, true);
  assert.equal(context.evaluateTool("read_file").allowed, true);
});

test("throws when config file is required but missing", () => {
  assert.throws(
    () =>
      new ToolPolicyRuntime({
        configFilePath: resolve(tmpdir(), `missing-${Date.now()}-${Math.random()}.json`),
        requireConfigFile: true
      }),
    /PI_TOOL_POLICY_FILE was set but file does not exist/
  );
});

test("applies layered rules with deny precedence", (t) => {
  const filePath = writeConfig({
    default: {
      allow: ["*"],
      deny: ["danger_*"]
    },
    byKind: {
      task: {
        allow: ["read_*", "web_*"],
        deny: ["web_private"]
      }
    },
    byProfile: {
      primary: {
        deny: ["read_secret"]
      }
    }
  });
  t.after(() => {
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  const runtime = new ToolPolicyRuntime({ configFilePath: filePath, requireConfigFile: true });
  const context = runtime.resolveContext("task", "primary");

  assert.equal(context.evaluateTool("read_file").allowed, true);
  assert.equal(context.evaluateTool("web_search").allowed, true);

  const blockedByDeny = context.evaluateTool("danger_exec");
  assert.equal(blockedByDeny.allowed, false);
  assert.equal(blockedByDeny.reason, "matched_deny_rule");
  assert.equal(blockedByDeny.matchedDenyPattern, "danger_*");

  const blockedByAllowlist = context.evaluateTool("edit_file");
  assert.equal(blockedByAllowlist.allowed, false);
  assert.equal(blockedByAllowlist.reason, "not_in_allowlist");

  const blockedByProfileDeny = context.evaluateTool("read_secret");
  assert.equal(blockedByProfileDeny.allowed, false);
  assert.equal(blockedByProfileDeny.reason, "matched_deny_rule");
  assert.equal(blockedByProfileDeny.matchedDenyPattern, "read_secret");
});

test("profile allowlist can narrow previous layers", (t) => {
  const filePath = writeConfig({
    default: {
      allow: ["read_*"]
    },
    byKind: {
      run: {
        allow: ["exec_*"]
      }
    },
    byProfile: {
      restricted: {
        allow: ["custom_*"],
        deny: ["custom_bad"]
      }
    }
  });
  t.after(() => {
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  const runtime = new ToolPolicyRuntime({ configFilePath: filePath, requireConfigFile: true });
  const context = runtime.resolveContext("run", "restricted");

  assert.equal(context.evaluateTool("custom_ok").allowed, true);

  const blockedKindAllow = context.evaluateTool("exec_any");
  assert.equal(blockedKindAllow.allowed, false);
  assert.equal(blockedKindAllow.reason, "not_in_allowlist");

  const blockedProfileDeny = context.evaluateTool("custom_bad");
  assert.equal(blockedProfileDeny.allowed, false);
  assert.equal(blockedProfileDeny.reason, "matched_deny_rule");
  assert.equal(blockedProfileDeny.matchedDenyPattern, "custom_bad");
});

test("empty allowlist denies all tools", (t) => {
  const filePath = writeConfig({
    default: {
      allow: []
    }
  });
  t.after(() => {
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  const runtime = new ToolPolicyRuntime({ configFilePath: filePath, requireConfigFile: true });
  const context = runtime.resolveContext("task", "primary");

  const blocked = context.evaluateTool("read_file");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "allowlist_empty");
});
