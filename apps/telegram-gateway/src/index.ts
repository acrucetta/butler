import { Bot } from "grammy";
import { createCommandRouter } from "./command-router.js";
import { formatError, sleep } from "./gateway-utils.js";
import { loadGatewayConfig } from "./gateway-config.js";
import { createJobTracker } from "./job-tracker.js";
import { registerMediaHandlers } from "./media-handler.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import { PairingStore } from "./pairing-store.js";
import { computePollingRetryDelayMs, isTelegramPollingConflictError } from "./polling-retry.js";
import { runProactiveDeliveryLoop } from "./proactive-poller.js";
import { SessionStore } from "./session-store.js";

const config = loadGatewayConfig();
const {
  botToken,
  orchestratorBaseUrl,
  gatewayToken,
  jobPollMs,
  promptMaxChars,
  rateLimitPerMinute,
  runOwnerOnly,
  approveOwnerOnly,
  allowRequesterAbort,
  notifyToolEvents,
  onlyAgentOutput,
  agentMarkdownV2,
  typingEnabled,
  typingHeartbeatMs,
  mediaEnabled,
  mediaMaxFileMb,
  mediaMaxFileBytes,
  mediaVisionMaxFileMb,
  mediaVisionMaxFileBytes,
  mediaTranscriptMaxChars,
  mediaVisionMaxChars,
  mediaSttModel,
  mediaVisionModel,
  mediaOpenAiApiKey,
  mediaOpenAiBaseUrl,
  proactiveDeliveryPollMs,
  pollingRetryBaseMs,
  pollingRetryMaxMs,
  pollingConflictMaxRetries,
  owners,
  allowFrom,
  gatewayDataPaths,
  pairingsFile,
  sessionsFile
} = config;

const bot = new Bot(botToken);
const orchestrator = new OrchestratorClient(orchestratorBaseUrl, gatewayToken);
const pairings = new PairingStore(pairingsFile, owners, allowFrom);
const sessions = new SessionStore(sessionsFile);

const jobTracker = createJobTracker({
  orchestrator,
  bot,
  jobPollMs,
  typingEnabled,
  typingHeartbeatMs,
  notifyToolEvents,
  onlyAgentOutput,
  agentMarkdownV2
});

const commandRouter = createCommandRouter({
  channel: "telegram",
  pairings,
  sessions,
  orchestrator,
  trackJob: jobTracker.trackJob,
  sendThreadMessage: jobTracker.sendThreadMessage,
  activeTrackers: jobTracker.activeTrackers,
  rateLimitPerMinute,
  runOwnerOnly,
  approveOwnerOnly,
  allowRequesterAbort,
  promptMaxChars,
  onlyAgentOutput
});

bot.on("message:text", (ctx) => commandRouter.handleTextMessage(ctx));

registerMediaHandlers(
  bot,
  {
    pairings,
    botToken,
    mediaEnabled,
    mediaMaxFileMb,
    mediaMaxFileBytes,
    mediaVisionMaxFileMb,
    mediaVisionMaxFileBytes,
    mediaTranscriptMaxChars,
    mediaVisionMaxChars,
    mediaSttModel,
    mediaVisionModel,
    mediaOpenAiApiKey,
    mediaOpenAiBaseUrl
  },
  {
    handleUnpairedMessage: commandRouter.handleUnpairedMessage,
    enforcePromptPolicies: commandRouter.enforcePromptPolicies,
    submitJob: commandRouter.submitJob
  }
);

bot.catch((error) => {
  console.error("[gateway] bot error", error.error);
});

const shutdownController = new AbortController();

void runProactiveDeliveryLoop(
  {
    orchestrator,
    sendTerminalJobMessage: jobTracker.sendTerminalJobMessage,
    proactiveDeliveryPollMs
  },
  shutdownController.signal
);

await startBotWithRetry();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[gateway] received ${signal}, stopping…`);
    shutdownController.abort();
    const stopPromise = Promise.resolve(bot.stop()).catch((err) =>
      console.warn(`[gateway] bot.stop() error: ${formatError(err)}`)
    );
    void stopPromise.finally(() => {
      setTimeout(() => process.exit(0), 2_000);
    });
  });
}

async function startBotWithRetry(): Promise<void> {
  let attempt = 0;
  let conflictAttempts = 0;
  for (;;) {
    try {
      await bot.start({
        onStart: (botInfo) => {
          console.log(`[gateway] bot started @${botInfo.username}`);
          console.log(`[gateway] owners=${owners.join(",")}`);
          console.log(`[gateway] workspace root=${gatewayDataPaths.workspaceRoot}`);
          console.log(`[gateway] pairings file=${pairingsFile}`);
          console.log(`[gateway] sessions file=${sessionsFile}`);
        }
      });
      return;
    } catch (error) {
      attempt += 1;
      const isConflict = isTelegramPollingConflictError(error);
      if (isConflict) {
        conflictAttempts += 1;
      }
      const delayMs = computePollingRetryDelayMs(attempt, pollingRetryBaseMs, pollingRetryMaxMs);
      if (isConflict) {
        console.warn(
          `[gateway] polling conflict ${conflictAttempts}/${pollingConflictMaxRetries}; retrying in ${delayMs}ms`
        );
        if (conflictAttempts >= pollingConflictMaxRetries) {
          console.error(
            `[gateway] 409 conflict persisted after ${conflictAttempts} attempts, exiting for clean restart`
          );
          process.exit(78);
        }
      } else {
        console.error(`[gateway] bot start failed: ${formatError(error)}; retrying in ${delayMs}ms`);
      }
      await sleep(delayMs);
    }
  }
}

