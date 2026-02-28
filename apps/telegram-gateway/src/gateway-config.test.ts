import assert from "node:assert/strict";
import test from "node:test";

import { loadGatewayConfig } from "./gateway-config.js";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: "test-telegram-token",
    ORCH_GATEWAY_TOKEN: "1234567890abcdef",
    TG_OWNER_IDS: "7646338597",
    OPENAI_API_KEY: "test-openai-key",
    ...overrides
  };
}

test("loads gateway config with defaults", () => {
  const config = loadGatewayConfig(baseEnv());
  assert.equal(config.botToken, "test-telegram-token");
  assert.equal(config.gatewayToken, "1234567890abcdef");
  assert.equal(config.owners[0], "7646338597");
  assert.equal(config.mediaEnabled, true);
  assert.equal(config.mediaOpenAiApiKey, "test-openai-key");
});

test("allows media key to be unset when media is disabled", () => {
  const config = loadGatewayConfig(
    baseEnv({
      TG_MEDIA_ENABLED: "false",
      OPENAI_API_KEY: ""
    })
  );
  assert.equal(config.mediaEnabled, false);
  assert.equal(config.mediaOpenAiApiKey, "");
});

test("throws when media enabled and OPENAI_API_KEY missing", () => {
  assert.throws(
    () =>
      loadGatewayConfig(
        baseEnv({
          OPENAI_API_KEY: ""
        })
      ),
    /TG_MEDIA_ENABLED=true requires OPENAI_API_KEY/
  );
});
