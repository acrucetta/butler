import type { Job } from "@pi-self/contracts";
import type { OrchestratorClient } from "./orchestrator-client.js";
import { formatError } from "./gateway-utils.js";

export interface ProactivePollConfig {
  orchestrator: OrchestratorClient;
  sendTerminalJobMessage(chatId: string, threadId: string | undefined, job: Job): Promise<void>;
  proactiveDeliveryPollMs: number;
}

export async function runProactiveDeliveryLoop(cfg: ProactivePollConfig, signal: AbortSignal): Promise<void> {
  const { orchestrator, sendTerminalJobMessage, proactiveDeliveryPollMs } = cfg;

  while (!signal.aborted) {
    try {
      const jobs = await orchestrator.listPendingProactiveDeliveries(20);
      if (jobs.length === 0) {
        await abortableSleep(proactiveDeliveryPollMs, signal);
        continue;
      }

      for (const job of jobs) {
        if (signal.aborted) break;
        try {
          const receipt = await deliverProactiveJob(job, sendTerminalJobMessage);
          await orchestrator.ackProactiveDelivery(job.id, receipt);
        } catch (error) {
          console.warn(`[gateway] proactive delivery failed job=${job.id}: ${formatError(error)}`);
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      console.warn(`[gateway] proactive delivery loop error: ${formatError(error)}`);
      await abortableSleep(proactiveDeliveryPollMs, signal);
    }
  }
  console.log("[gateway] proactive delivery loop stopped");
}

async function deliverProactiveJob(
  job: Job,
  sendTerminalJobMessage: (chatId: string, threadId: string | undefined, job: Job) => Promise<void>
): Promise<string> {
  const mode = job.metadata?.proactiveDeliveryMode ?? "announce";
  if (mode === "none") {
    return `none:${new Date().toISOString()}`;
  }

  if (mode === "announce") {
    await sendTerminalJobMessage(job.chatId, job.threadId, job);
    return `announce:${new Date().toISOString()}`;
  }

  if (mode === "webhook") {
    const url = job.metadata?.proactiveDeliveryWebhookUrl;
    if (!url) {
      throw new Error("missing proactiveDeliveryWebhookUrl");
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        status: job.status,
        resultText: job.resultText ?? "",
        error: job.error ?? "",
        finishedAt: job.finishedAt ?? null,
        trigger: {
          kind: job.metadata?.proactiveTriggerKind ?? null,
          id: job.metadata?.proactiveTriggerId ?? null
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`webhook delivery failed (${response.status}): ${text}`);
    }

    return `webhook:${new Date().toISOString()}`;
  }

  throw new Error(`unsupported proactive delivery mode '${mode}'`);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
