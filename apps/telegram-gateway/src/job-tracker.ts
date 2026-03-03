import type { Job } from "@pi-self/contracts";
import { isTerminalStatus } from "@pi-self/contracts";
import type { Bot } from "grammy";
import type { OrchestratorClient } from "./orchestrator-client.js";
import { formatError, sleep } from "./gateway-utils.js";
import { toTelegramMarkdownV2 } from "./telegram-markdown.js";
import { startTypingIndicator } from "./typing-indicator.js";

export type TelegramMessageFormat = "plain" | "markdownv2";

export interface JobTrackerConfig {
  orchestrator: OrchestratorClient;
  bot: Bot;
  jobPollMs: number;
  typingEnabled: boolean;
  typingHeartbeatMs: number;
  notifyToolEvents: boolean;
  onlyAgentOutput: boolean;
  agentMarkdownV2: boolean;
}

export interface JobTracker {
  trackJob(chatId: string, threadId: string | undefined, jobId: string): Promise<void>;
  sendThreadMessage(chatId: string, threadId: string | undefined, text: string, format?: TelegramMessageFormat): Promise<void>;
  sendTerminalJobMessage(chatId: string, threadId: string | undefined, job: Job): Promise<void>;
  activeTrackers: Set<string>;
}

export function createJobTracker(cfg: JobTrackerConfig): JobTracker {
  const { orchestrator, bot, jobPollMs, typingEnabled, typingHeartbeatMs, notifyToolEvents, onlyAgentOutput, agentMarkdownV2 } = cfg;
  const activeTrackers = new Set<string>();

  async function sendThreadMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
    format: TelegramMessageFormat = "plain"
  ): Promise<void> {
    const chat = Number(chatId);
    if (Number.isNaN(chat)) {
      throw new Error(`invalid chat id: ${chatId}`);
    }

    const thread = threadId ? Number(threadId) : undefined;
    const messageThreadId = threadId && !Number.isNaN(thread) ? thread : undefined;

    if (format === "markdownv2") {
      try {
        await bot.api.sendMessage(chat, toTelegramMarkdownV2(text), {
          message_thread_id: messageThreadId,
          parse_mode: "MarkdownV2"
        });
        return;
      } catch (error) {
        if (!isTelegramEntityParseError(error)) {
          throw error;
        }
        console.warn(`[gateway] MarkdownV2 send failed, falling back to plain text: ${formatError(error)}`);
      }
    }

    await bot.api.sendMessage(chat, text, {
      message_thread_id: messageThreadId
    });
  }

  async function sendTypingAction(chatId: string, threadId: string | undefined): Promise<void> {
    const chat = Number(chatId);
    if (Number.isNaN(chat)) {
      return;
    }

    const thread = threadId ? Number(threadId) : undefined;
    const messageThreadId = threadId && !Number.isNaN(thread) ? thread : undefined;
    try {
      await bot.api.sendChatAction(chat, "typing", {
        message_thread_id: messageThreadId
      });
    } catch {
      // best-effort signal only
    }
  }

  async function sendTerminalJobMessage(chatId: string, threadId: string | undefined, job: Job): Promise<void> {
    if (job.status === "completed") {
      const result = job.resultText?.trim() || "";

      const isProactiveJob = job.sessionKey?.startsWith("proactive:");
      if (isProactiveJob && (!result || result === "__SILENT__")) {
        console.log(`[gateway] silent reply for proactive job=${job.id}, skipping Telegram message`);
        return;
      }
      if (!isProactiveJob && !result) {
        await sendThreadMessage(chatId, threadId, "Done (no output).");
        return;
      }

      const chunks = splitMessage(result, agentMarkdownV2 ? 2800 : 3500);

      if (!onlyAgentOutput) {
        await sendThreadMessage(chatId, threadId, `Job ${job.id} completed.`);
      }
      for (const chunk of chunks) {
        await sendThreadMessage(chatId, threadId, chunk, agentMarkdownV2 ? "markdownv2" : "plain");
      }
      return;
    }

    if (job.status === "aborted") {
      await sendThreadMessage(chatId, threadId, onlyAgentOutput ? "Execution aborted." : `Job ${job.id} aborted.`);
      return;
    }

    if (job.status === "failed") {
      await sendThreadMessage(chatId, threadId, `Job ${job.id} failed:\n${job.error ?? "Unknown error"}`);
      return;
    }
  }

  async function trackJob(chatId: string, threadId: string | undefined, jobId: string): Promise<void> {
    if (activeTrackers.has(jobId)) {
      return;
    }

    activeTrackers.add(jobId);
    const typingIndicator = startTypingIndicator({
      enabled: typingEnabled,
      intervalMs: typingHeartbeatMs,
      tick: () => sendTypingAction(chatId, threadId)
    });
    let cursor = 0;
    let runningNotified = false;

    try {
      for (;;) {
        const events = await orchestrator.getEvents(jobId, cursor);
        cursor = events.nextCursor;

        for (const event of events.events) {
          if (!onlyAgentOutput && event.type === "job_started" && !runningNotified) {
            runningNotified = true;
            await sendThreadMessage(chatId, threadId, `Job ${jobId} started in VM.`);
          }

          if (!onlyAgentOutput && notifyToolEvents && event.type === "tool_start" && event.data?.toolName) {
            await sendThreadMessage(chatId, threadId, `Tool: ${String(event.data.toolName)} started.`);
          }
        }

        const job = await orchestrator.getJob(jobId);
        if (isTerminalStatus(job.status)) {
          await sendTerminalJobMessage(chatId, threadId, job);
          break;
        }

        await sleep(jobPollMs);
      }
    } catch (error) {
      await sendThreadMessage(chatId, threadId, `Tracking failed for ${jobId}: ${formatError(error)}`);
    } finally {
      typingIndicator.stop();
      activeTrackers.delete(jobId);
    }
  }

  return { trackJob, sendThreadMessage, sendTerminalJobMessage, activeTrackers };
}

function splitMessage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const slice = text.slice(offset, offset + maxChars);
    chunks.push(slice);
    offset += maxChars;
  }

  return chunks;
}

function isTelegramEntityParseError(error: unknown): boolean {
  const text = formatError(error).toLowerCase();
  return text.includes("can't parse entities") || text.includes("parse entities");
}
