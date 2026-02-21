import type { Job } from "@pi-self/contracts";
import { isTerminalStatus } from "@pi-self/contracts";
import { Bot } from "grammy";
import { OrchestratorClient } from "./orchestrator-client.js";
import { PairingStore } from "./pairing-store.js";
import { SessionStore } from "./session-store.js";
import { toTelegramMarkdownV2 } from "./telegram-markdown.js";

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  consume(key: string): { allowed: boolean; retryAfterMs: number } {
    if (this.limit <= 0) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const current = this.buckets.get(key) ?? [];
    const recent = current.filter((ts) => ts >= cutoff);

    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now);
      this.buckets.set(key, recent);
      return { allowed: false, retryAfterMs };
    }

    recent.push(now);
    this.buckets.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

const botToken = requireEnv("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN);
const orchestratorBaseUrl = process.env.ORCH_BASE_URL ?? "http://127.0.0.1:8787";
const gatewayToken = requireSecret("ORCH_GATEWAY_TOKEN", process.env.ORCH_GATEWAY_TOKEN);
const jobPollMs = parsePositiveInt(process.env.TG_JOB_POLL_MS, 2_000);
const promptMaxChars = parsePositiveInt(process.env.TG_PROMPT_MAX_CHARS, 8_000);
const rateLimitPerMinute = parsePositiveInt(process.env.TG_RATE_LIMIT_PER_MIN, 12);
const runOwnerOnly = parseBoolean(process.env.TG_RUN_OWNER_ONLY, true);
const approveOwnerOnly = parseBoolean(process.env.TG_APPROVE_OWNER_ONLY, true);
const allowRequesterAbort = parseBoolean(process.env.TG_ALLOW_REQUESTER_ABORT, true);
const notifyToolEvents = parseBoolean(process.env.TG_NOTIFY_TOOL_EVENTS, false);
const onlyAgentOutput = parseBoolean(process.env.TG_ONLY_AGENT_OUTPUT, true);
const agentMarkdownV2 = parseBoolean(process.env.TG_AGENT_MARKDOWNV2, true);
const mediaEnabled = parseBoolean(process.env.TG_MEDIA_ENABLED, true);
const mediaMaxFileMb = parsePositiveInt(process.env.TG_MEDIA_MAX_FILE_MB, 20);
const mediaMaxFileBytes = mediaMaxFileMb * 1024 * 1024;
const mediaVisionMaxFileMb = parsePositiveInt(process.env.TG_MEDIA_VISION_MAX_FILE_MB, 8);
const mediaVisionMaxFileBytes = mediaVisionMaxFileMb * 1024 * 1024;
const mediaTranscriptMaxChars = parsePositiveInt(process.env.TG_MEDIA_TRANSCRIPT_MAX_CHARS, 6_000);
const mediaVisionMaxChars = parsePositiveInt(process.env.TG_MEDIA_VISION_MAX_CHARS, 4_000);
const mediaSttModel = process.env.TG_MEDIA_STT_MODEL?.trim() || "gpt-4o-mini-transcribe";
const mediaVisionModel = process.env.TG_MEDIA_VISION_MODEL?.trim() || "gpt-5-mini";
const mediaOpenAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
const mediaOpenAiBaseUrl = normalizeOpenAiBaseUrl(process.env.OPENAI_BASE_URL);
const proactiveDeliveryPollMs = parsePositiveInt(process.env.TG_PROACTIVE_DELIVERY_POLL_MS, 3_000);
const owners = splitCsv(process.env.TG_OWNER_IDS ?? "");
const allowFrom = splitCsv(process.env.TG_ALLOW_FROM ?? "");
const pairingsFile = process.env.TG_PAIRINGS_FILE ?? ".data/gateway/pairings.json";
const sessionsFile = process.env.TG_SESSIONS_FILE ?? ".data/gateway/sessions.json";

if (owners.length === 0) {
  throw new Error("TG_OWNER_IDS must include at least one Telegram user ID");
}

if (mediaEnabled && !mediaOpenAiApiKey) {
  throw new Error("TG_MEDIA_ENABLED=true requires OPENAI_API_KEY");
}

const bot = new Bot(botToken);
const orchestrator = new OrchestratorClient(orchestratorBaseUrl, gatewayToken);
const pairings = new PairingStore(pairingsFile, owners, allowFrom);
const sessions = new SessionStore(sessionsFile);
const activeTrackers = new Set<string>();
const rateLimiter = new SlidingWindowRateLimiter(rateLimitPerMinute, 60_000);

bot.on("message:text", async (ctx) => {
  try {
    const text = ctx.message.text.trim();
    const fromId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat.id);
    const threadId = ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined;

    if (!fromId) {
      return;
    }

    if (text === "/whoami") {
      await ctx.reply(`telegram_user_id=${fromId}`);
      return;
    }

    if (!pairings.isAllowed(fromId)) {
      await handleUnpairedMessage(ctx, fromId);
      return;
    }

    if (text === "/start" || text === "/help") {
      await ctx.reply(helpText());
      return;
    }

    if (text === "/pairings") {
      if (!pairings.isOwner(fromId)) {
        await ctx.reply("Owner-only command.");
        return;
      }

      const pending = pairings.listPending();
      if (pending.length === 0) {
        await ctx.reply("No pending pairing requests.");
        return;
      }

      const summary = pending
        .map((entry) => `code=${entry.code} user=${entry.userId} created=${entry.createdAt}`)
        .join("\n");
      await ctx.reply(`Pending pairings:\n${summary}`);
      return;
    }

    if (text.startsWith("/approvepair ")) {
      if (!pairings.isOwner(fromId)) {
        await ctx.reply("Owner-only command.");
        return;
      }

      const code = text.slice("/approvepair ".length).trim().toUpperCase();
      if (!code) {
        await ctx.reply("Usage: /approvepair <CODE>");
        return;
      }

      const approved = pairings.approveCode(code);
      if (!approved) {
        await ctx.reply(`No pending pairing found for code ${code}.`);
        return;
      }

      await ctx.reply(`Approved user ${approved.userId}`);
      return;
    }

    if (text === "/panic" || text.startsWith("/panic ")) {
      if (!pairings.isOwner(fromId)) {
        await ctx.reply("Owner-only command.");
        return;
      }

      await handlePanic(ctx, text);
      return;
    }

    if (text === "/status") {
      await handleStatusSummary(ctx, chatId, threadId);
      return;
    }

    if (text.startsWith("/status ")) {
      const jobId = text.slice("/status ".length).trim();
      if (!jobId) {
        await ctx.reply("Usage: /status <jobId>");
        return;
      }

      await handleStatus(ctx, fromId, chatId, jobId);
      return;
    }

    if (text.startsWith("/approve ")) {
      const jobId = text.slice("/approve ".length).trim();
      if (!jobId) {
        await ctx.reply("Usage: /approve <jobId>");
        return;
      }

      await handleApproveJob(ctx, fromId, jobId);
      return;
    }

    if (text.startsWith("/abort ")) {
      const jobId = text.slice("/abort ".length).trim();
      if (!jobId) {
        await ctx.reply("Usage: /abort <jobId>");
        return;
      }

      await handleAbortJob(ctx, fromId, chatId, jobId);
      return;
    }

    if (text === "/context") {
      await handleContext(ctx, chatId, threadId);
      return;
    }

    if (text === "/new" || text.startsWith("/new ")) {
      const remainder = text.slice("/new".length).trim();
      await handleResetSession(ctx, fromId, chatId, threadId, remainder);
      return;
    }

    if (text === "/reset" || text.startsWith("/reset ")) {
      const remainder = text.slice("/reset".length).trim();
      await handleResetSession(ctx, fromId, chatId, threadId, remainder);
      return;
    }

    if (text.startsWith("/task ")) {
      const prompt = text.slice("/task ".length).trim();
      if (!prompt) {
        await ctx.reply("Usage: /task <request>");
        return;
      }

      const limited = await enforcePromptPolicies(ctx, fromId, prompt);
      if (!limited) {
        return;
      }

      await submitJob(ctx, prompt, "task", false);
      return;
    }

    if (text.startsWith("/run ")) {
      if (runOwnerOnly && !pairings.isOwner(fromId)) {
        await ctx.reply("/run is owner-only in this deployment.");
        return;
      }

      const command = text.slice("/run ".length).trim();
      if (!command) {
        await ctx.reply("Usage: /run <command>");
        return;
      }

      const limited = await enforcePromptPolicies(ctx, fromId, command);
      if (!limited) {
        return;
      }

      await submitJob(ctx, command, "run", true);
      return;
    }

    if (text.startsWith("/")) {
      await ctx.reply(helpText());
      return;
    }

    const limited = await enforcePromptPolicies(ctx, fromId, text);
    if (!limited) {
      return;
    }

    await submitJob(ctx, text, "task", false);
  } catch (error) {
    await ctx.reply(`Request failed: ${formatError(error)}`);
  }
});

bot.on("message:voice", async (ctx) => {
  await handleVoiceOrAudioMessage(ctx, "voice");
});

bot.on("message:audio", async (ctx) => {
  await handleVoiceOrAudioMessage(ctx, "audio");
});

bot.on("message:photo", async (ctx) => {
  try {
    const fromId = String(ctx.from?.id ?? "");
    if (!fromId) {
      return;
    }

    if (!pairings.isAllowed(fromId)) {
      await handleUnpairedMessage(ctx, fromId);
      return;
    }

    if (!mediaEnabled) {
      await ctx.reply("Photo understanding is disabled. Set TG_MEDIA_ENABLED=true to enable media processing.");
      return;
    }

    const photo = selectLargestPhoto(ctx.message.photo ?? []);
    if (!photo?.file_id) {
      await ctx.reply("Could not read photo payload from Telegram.");
      return;
    }

    if (typeof photo.file_size === "number" && photo.file_size > mediaMaxFileBytes) {
      await ctx.reply(`Photo is too large (${formatMb(photo.file_size)} MB). Max allowed is ${mediaMaxFileMb} MB.`);
      return;
    }

    const file = await downloadTelegramFile(photo.file_id);
    if (file.bytes.length > mediaVisionMaxFileBytes) {
      await ctx.reply(
        `Photo is too large (${formatMb(file.bytes.length)} MB). Max allowed for photo analysis is ${mediaVisionMaxFileMb} MB.`
      );
      return;
    }

    const caption = (ctx.message.caption ?? "").trim();
    const detectedMimeType = detectImageMimeTypeFromBytes(file.bytes) ?? file.mimeType ?? "image/jpeg";
    if (!isSupportedImageMimeType(detectedMimeType)) {
      await ctx.reply(`Unsupported photo format (${detectedMimeType}). Send JPG, PNG, or WEBP.`);
      return;
    }

    const analysis = await generateImageAnalysis(file.bytes, detectedMimeType);
    const prompt = buildPhotoPrompt(
      truncateText(analysis, mediaVisionMaxChars, "photo analysis"),
      caption
    );

    const limited = await enforcePromptPolicies(ctx, fromId, prompt);
    if (!limited) {
      return;
    }

    await submitJob(ctx, prompt, "task", false, {
      telegramInputType: "photo",
      telegramMediaMimeType: file.mimeType ?? "image/jpeg"
    });
  } catch (error) {
    console.warn(`[gateway] photo handler failed: ${formatError(error)}`);
    await ctx.reply(`Request failed: ${formatError(error)}`);
  }
});

bot.catch((error) => {
  console.error("[gateway] bot error", error.error);
});

await bot.start({
  onStart: (botInfo) => {
    console.log(`[gateway] bot started @${botInfo.username}`);
    console.log(`[gateway] owners=${owners.join(",")}`);
  }
});

void runProactiveDeliveryLoop();

async function handleUnpairedMessage(ctx: any, fromId: string): Promise<void> {
  if (ctx.chat.type !== "private") {
    return;
  }

  const code = pairings.issuePairingCode(fromId);
  await ctx.reply([
    "You are not paired with this agent yet.",
    `Your Telegram user id: ${fromId}`,
    `Pairing code: ${code}`,
    "Ask the owner to run /pairings then /approvepair <CODE>."
  ].join("\n"));
}

async function handlePanic(ctx: any, text: string): Promise<void> {
  const arg = text === "/panic" ? "status" : text.slice("/panic ".length).trim().toLowerCase();

  if (arg === "status") {
    const admin = await orchestrator.getAdminState();
    await ctx.reply(renderAdminState(admin));
    return;
  }

  if (arg === "on") {
    const admin = await orchestrator.pause("panic command from Telegram owner");
    await ctx.reply(`Panic enabled. ${renderAdminState(admin)}`);
    return;
  }

  if (arg === "off") {
    const admin = await orchestrator.resume();
    await ctx.reply(`Panic disabled. ${renderAdminState(admin)}`);
    return;
  }

  await ctx.reply("Usage: /panic [status|on|off]");
}

async function handleStatusSummary(ctx: any, chatId: string, threadId?: string): Promise<void> {
  const admin = await orchestrator.getAdminState();
  const session = sessions.getSession(chatId, threadId);

  await ctx.reply([
    "Gateway status:",
    renderAdminState(admin),
    renderSessionSummary(session.chatId, session.threadId, session.sessionKey, session.generation, session.lastResetAt),
    `active_trackers: ${activeTrackers.size}`
  ].join("\n"));
}

async function handleContext(ctx: any, chatId: string, threadId?: string): Promise<void> {
  const session = sessions.getSession(chatId, threadId);
  await ctx.reply([
    "Session context:",
    renderSessionSummary(session.chatId, session.threadId, session.sessionKey, session.generation, session.lastResetAt),
    `created: ${session.createdAt}`,
    `updated: ${session.updatedAt}`,
    `route: ${session.routeKey}`
  ].join("\n"));
}

async function handleResetSession(
  ctx: any,
  fromId: string,
  chatId: string,
  threadId: string | undefined,
  promptAfterReset: string
): Promise<void> {
  const session = sessions.resetSession(chatId, threadId);
  await ctx.reply([
    "Session reset.",
    renderSessionSummary(session.chatId, session.threadId, session.sessionKey, session.generation, session.lastResetAt)
  ].join("\n"));

  if (!promptAfterReset) {
    return;
  }

  const limited = await enforcePromptPolicies(ctx, fromId, promptAfterReset);
  if (!limited) {
    return;
  }

  await submitJob(ctx, promptAfterReset, "task", false);
}

async function handleVoiceOrAudioMessage(ctx: any, inputType: "voice" | "audio"): Promise<void> {
  try {
    const fromId = String(ctx.from?.id ?? "");
    if (!fromId) {
      return;
    }

    if (!pairings.isAllowed(fromId)) {
      await handleUnpairedMessage(ctx, fromId);
      return;
    }

    if (!mediaEnabled) {
      await ctx.reply("Voice and photo understanding is disabled. Set TG_MEDIA_ENABLED=true to enable media processing.");
      return;
    }

    const payload = inputType === "voice" ? ctx.message.voice : ctx.message.audio;
    if (!payload?.file_id) {
      await ctx.reply("Could not read the audio payload from Telegram.");
      return;
    }

    if (typeof payload.file_size === "number" && payload.file_size > mediaMaxFileBytes) {
      await ctx.reply(`Audio file is too large (${formatMb(payload.file_size)} MB). Max allowed is ${mediaMaxFileMb} MB.`);
      return;
    }

    const file = await downloadTelegramFile(payload.file_id);
    if (file.bytes.length > mediaMaxFileBytes) {
      await ctx.reply(`Audio file is too large (${formatMb(file.bytes.length)} MB). Max allowed is ${mediaMaxFileMb} MB.`);
      return;
    }

    const transcript = await transcribeAudio(
      file.bytes,
      normalizeAudioUploadFilename(file.filePath, inputType),
      file.mimeType ?? payload.mime_type ?? "audio/ogg"
    );
    const caption = (ctx.message.caption ?? "").trim();
    const prompt = buildVoicePrompt(
      truncateText(transcript, mediaTranscriptMaxChars, "voice transcript"),
      caption,
      inputType
    );

    const limited = await enforcePromptPolicies(ctx, fromId, prompt);
    if (!limited) {
      return;
    }

    const metadata: Record<string, string> = {
      telegramInputType: inputType,
      telegramMediaMimeType: file.mimeType ?? payload.mime_type ?? "audio/ogg"
    };
    if (typeof payload.duration === "number") {
      metadata.telegramMediaDurationSeconds = String(payload.duration);
    }

    await submitJob(ctx, prompt, "task", false, metadata);
  } catch (error) {
    console.warn(`[gateway] ${inputType} handler failed: ${formatError(error)}`);
    await ctx.reply(`Request failed: ${formatError(error)}`);
  }
}

async function downloadTelegramFile(fileId: string): Promise<{ bytes: Buffer; filePath?: string; mimeType?: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram file path missing for media payload");
  }

  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeTypeFromBytes = guessMimeTypeFromBytes(buffer);
  const mimeTypeFromPath = guessMimeTypeFromPath(file.file_path);
  return {
    bytes: buffer,
    filePath: file.file_path,
    mimeType: mimeTypeFromBytes ?? mimeTypeFromPath
  };
}

async function transcribeAudio(bytes: Buffer, filename: string, mimeType: string): Promise<string> {
  const form = new FormData();
  form.set("model", mediaSttModel);
  form.set("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

  const response = await fetch(`${mediaOpenAiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mediaOpenAiApiKey}`
    },
    body: form
  });

  if (!response.ok) {
    throw new Error(`Audio transcription failed (${response.status}): ${await readErrorBody(response)}`);
  }

  const payload = (await response.json()) as { text?: string };
  const text = payload.text?.trim();
  if (!text) {
    throw new Error("Audio transcription response was empty");
  }

  return text;
}

async function generateImageAnalysis(bytes: Buffer, mimeType: string): Promise<string> {
  const candidates = buildImageMimeCandidates(bytes, mimeType);
  let lastError: unknown = undefined;

  for (const candidateMime of candidates) {
    try {
      return await requestImageAnalysis(bytes, candidateMime);
    } catch (error) {
      lastError = error;
      if (!isRecoverableImageParseError(error)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Photo analysis failed");
}

function buildVoicePrompt(transcript: string, caption: string, inputType: "voice" | "audio"): string {
  const lines = [
    `Telegram ${inputType === "voice" ? "voice note" : "audio file"} received.`,
    "Treat the transcript below as user input."
  ];

  if (caption) {
    lines.push(`Telegram caption/context:\n${caption}`);
  }

  lines.push(`Transcript:\n${transcript}`);
  return lines.join("\n\n");
}

function buildPhotoPrompt(analysis: string, caption: string): string {
  const lines = [
    "Telegram photo received.",
    "Treat the analysis below as the user-provided visual context."
  ];

  if (caption) {
    lines.push(`Telegram caption/context:\n${caption}`);
  }

  lines.push(`Photo analysis:\n${analysis}`);
  return lines.join("\n\n");
}

function selectLargestPhoto(photos: any[]): any | undefined {
  if (photos.length === 0) {
    return undefined;
  }

  return photos.reduce((best, current) => {
    if (!best) return current;
    const bestSize = typeof best.file_size === "number" ? best.file_size : 0;
    const currentSize = typeof current.file_size === "number" ? current.file_size : 0;
    return currentSize >= bestSize ? current : best;
  }, undefined as any);
}

function guessMimeTypeFromPath(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return undefined;
}

function guessMimeTypeFromBytes(bytes: Buffer): string | undefined {
  if (bytes.length < 12) {
    return undefined;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return "audio/ogg";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "audio/wav";
  }
  if (
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    return "audio/mpeg";
  }
  return undefined;
}

function detectImageMimeTypeFromBytes(bytes: Buffer): string | undefined {
  const mimeType = guessMimeTypeFromBytes(bytes);
  return mimeType && isSupportedImageMimeType(mimeType) ? mimeType : undefined;
}

function isSupportedImageMimeType(mimeType: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp";
}

function buildImageMimeCandidates(bytes: Buffer, primaryMimeType: string): string[] {
  const detected = detectImageMimeTypeFromBytes(bytes);
  const values = [primaryMimeType, detected, "image/jpeg", "image/png", "image/webp"];
  const unique = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (!isSupportedImageMimeType(value)) continue;
    unique.add(value);
  }
  return [...unique];
}

async function requestImageAnalysis(bytes: Buffer, mimeType: string): Promise<string> {
  const imageDataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;

  const response = await fetch(`${mediaOpenAiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mediaOpenAiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: mediaVisionModel,
      messages: [
        {
          role: "system",
          content:
            "You analyze Telegram photos for an assistant. Describe what is visible and extract any readable text. Be concise and factual."
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this Telegram photo and include key text visible in the image." },
            { type: "image_url", image_url: { url: imageDataUrl } }
          ]
        }
      ],
      reasoning_effort: "minimal",
      max_completion_tokens: 1200
    })
  });

  if (!response.ok) {
    throw new Error(`Photo analysis failed (${response.status}): ${await readErrorBody(response)}`);
  }

  const payload = (await response.json()) as ChatCompletionsResponse;
  const analysis = extractChatMessageText(payload);
  if (!analysis) {
    throw new Error("Photo analysis response was empty");
  }

  return analysis.trim();
}

function normalizeAudioUploadFilename(filePath: string | undefined, inputType: "voice" | "audio"): string {
  const fallback = inputType === "voice" ? "voice.ogg" : "audio.mp3";
  const leaf = filePath ? filePath.split("/").pop() ?? "" : "";
  const candidate = leaf.trim() || fallback;
  const lower = candidate.toLowerCase();

  if (lower.endsWith(".oga")) {
    return `${candidate.slice(0, -4)}.ogg`;
  }
  if (lower.endsWith(".opus")) {
    return `${candidate.slice(0, -5)}.ogg`;
  }
  if (!/\.[a-z0-9]+$/i.test(candidate)) {
    return inputType === "voice" ? `${candidate}.ogg` : `${candidate}.mp3`;
  }

  return candidate;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function truncateText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[${label} truncated to ${maxChars} characters]`;
}

function mergeJobMetadata(
  ...entries: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (value.length > 0) {
        merged[key] = value;
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function submitJob(
  ctx: any,
  prompt: string,
  kind: "task" | "run",
  requiresApproval: boolean,
  metadata?: Record<string, string>
): Promise<void> {
  const fromId = String(ctx.from?.id ?? "");
  const chatId = String(ctx.chat.id);
  const threadId = ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined;
  const session = sessions.touchSession(chatId, threadId);
  const sessionKey = session.sessionKey;

  const admin = await orchestrator.getAdminState();
  const job = await orchestrator.createJob({
    kind,
    prompt,
    channel: "telegram",
    chatId,
    threadId,
    requesterId: fromId,
    sessionKey,
    requiresApproval,
    metadata: mergeJobMetadata(kind === "run" ? { command: prompt } : undefined, metadata)
  });

  if (requiresApproval) {
    await sendThreadMessage(chatId, threadId, `Pending approval. Use /approve ${job.id} to run it.`);
  } else if (!onlyAgentOutput) {
    await sendThreadMessage(chatId, threadId, [
      `Job created: ${job.id}`,
      `status: ${job.status}`,
      admin.paused ? "Execution is paused (/panic on). Job will wait." : undefined,
      "Running..."
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"));
  }

  if (job.status !== "needs_approval") {
    void trackJob(job.chatId, job.threadId, job.id);
  }
}

async function handleStatus(ctx: any, fromId: string, chatId: string, jobId: string): Promise<void> {
  const job = await orchestrator.getJob(jobId);
  if (!canViewJob(fromId, chatId, job)) {
    await ctx.reply("You are not allowed to view that job.");
    return;
  }

  await ctx.reply(renderJobStatus(job));
}

async function handleApproveJob(ctx: any, fromId: string, jobId: string): Promise<void> {
  if (approveOwnerOnly && !pairings.isOwner(fromId)) {
    await ctx.reply("Only owners can approve jobs.");
    return;
  }

  const jobBefore = await orchestrator.getJob(jobId);
  if (!pairings.isOwner(fromId) && !canViewJob(fromId, String(ctx.chat.id), jobBefore)) {
    await ctx.reply("You are not allowed to approve that job.");
    return;
  }

  const job = await orchestrator.approveJob(jobId);
  await ctx.reply(`Job ${job.id} status: ${job.status}`);

  if (!isTerminalStatus(job.status)) {
    void trackJob(job.chatId, job.threadId, job.id);
  }
}

async function handleAbortJob(ctx: any, fromId: string, chatId: string, jobId: string): Promise<void> {
  const jobBefore = await orchestrator.getJob(jobId);
  const owner = pairings.isOwner(fromId);
  const requesterAbortAllowed =
    allowRequesterAbort && jobBefore.requesterId === fromId && jobBefore.chatId === chatId;

  if (!owner && !requesterAbortAllowed) {
    await ctx.reply("You are not allowed to abort that job.");
    return;
  }

  const job = await orchestrator.abortJob(jobId);
  await ctx.reply(`Abort requested for ${job.id}. Current status: ${job.status}`);
}

async function enforcePromptPolicies(ctx: any, userId: string, prompt: string): Promise<boolean> {
  if (prompt.length > promptMaxChars) {
    await ctx.reply(`Prompt too long (${prompt.length}). Max allowed is ${promptMaxChars} characters.`);
    return false;
  }

  const limit = rateLimiter.consume(userId);
  if (!limit.allowed) {
    const waitSecs = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    await ctx.reply(`Rate limit hit. Try again in about ${waitSecs}s.`);
    return false;
  }

  return true;
}

function canViewJob(userId: string, chatId: string, job: Job): boolean {
  if (pairings.isOwner(userId)) {
    return true;
  }
  return job.requesterId === userId && job.chatId === chatId;
}

async function trackJob(chatId: string, threadId: string | undefined, jobId: string): Promise<void> {
  if (activeTrackers.has(jobId)) {
    return;
  }

  activeTrackers.add(jobId);
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
    activeTrackers.delete(jobId);
  }
}

async function sendTerminalJobMessage(chatId: string, threadId: string | undefined, job: Job): Promise<void> {
  if (job.status === "completed") {
    const result = job.resultText?.trim() || "(No output)";
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

type TelegramMessageFormat = "plain" | "markdownv2";

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

function renderJobStatus(job: Job): string {
  return [
    `job: ${job.id}`,
    `status: ${job.status}`,
    `kind: ${job.kind}`,
    `requester: ${job.requesterId}`,
    `chat: ${job.chatId}`,
    `created: ${job.createdAt}`,
    `updated: ${job.updatedAt}`,
    job.workerId ? `worker: ${job.workerId}` : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderAdminState(admin: { paused: boolean; pauseReason?: string; updatedAt: string }): string {
  return [
    `paused: ${admin.paused}`,
    admin.pauseReason ? `reason: ${admin.pauseReason}` : undefined,
    `updated: ${admin.updatedAt}`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionSummary(
  chatId: string,
  threadId: string | undefined,
  sessionKey: string,
  generation: number,
  lastResetAt: string
): string {
  return [
    `chat: ${chatId}`,
    threadId ? `thread: ${threadId}` : undefined,
    `session: ${sessionKey}`,
    `session_generation: ${generation}`,
    `session_reset_at: ${lastResetAt}`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function helpText(): string {
  return [
    "Commands:",
    "/whoami - show your Telegram user id",
    "/task <request> - create a normal task",
    "/run <command> - create a command job (approval required)",
    "/approve <jobId> - approve a pending /run job",
    "/abort <jobId> - request abort",
    "/status - show gateway/session status for this chat",
    "/status <jobId> - fetch status for a specific job",
    "/context - show current chat session context key",
    "/new [prompt] - reset session context; optional prompt runs in new session",
    "/reset [prompt] - same as /new",
    "/panic [status|on|off] - pause/resume execution (owner)",
    "/pairings - list pending pairings (owner)",
    "/approvepair <code> - approve pairing (owner)",
    "",
    "Plain text is treated like /task",
    "Voice notes, audio files, and photos are treated like /task when media understanding is enabled"
  ].join("\n");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function runProactiveDeliveryLoop(): Promise<void> {
  for (;;) {
    try {
      const jobs = await orchestrator.listPendingProactiveDeliveries(20);
      if (jobs.length === 0) {
        await sleep(proactiveDeliveryPollMs);
        continue;
      }

      for (const job of jobs) {
        try {
          const receipt = await deliverProactiveJob(job);
          await orchestrator.ackProactiveDelivery(job.id, receipt);
        } catch (error) {
          console.warn(`[gateway] proactive delivery failed job=${job.id}: ${formatError(error)}`);
        }
      }
    } catch (error) {
      console.warn(`[gateway] proactive delivery loop error: ${formatError(error)}`);
      await sleep(proactiveDeliveryPollMs);
    }
  }
}

async function deliverProactiveJob(job: Job): Promise<string> {
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

function normalizeOpenAiBaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    return "https://api.openai.com/v1";
  }
  return value.replace(/\/+$/g, "");
}

async function readErrorBody(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  if (!text) {
    return "(empty response body)";
  }

  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function extractChatMessageText(payload: ChatCompletionsResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }

  return "";
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRecoverableImageParseError(error: unknown): boolean {
  const text = formatError(error).toLowerCase();
  return (
    text.includes("image_parse_error") ||
    text.includes("invalid image") ||
    text.includes("unsupported image")
  );
}

function isTelegramEntityParseError(error: unknown): boolean {
  const text = formatError(error).toLowerCase();
  return text.includes("can't parse entities") || text.includes("parse entities");
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function requireSecret(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required secret ${name}`);
  }
  if (value.length < 16) {
    throw new Error(`${name} must be at least 16 characters`);
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
