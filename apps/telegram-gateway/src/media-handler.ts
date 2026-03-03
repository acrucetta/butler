import type { Bot } from "grammy";
import { formatError, parseSender } from "./gateway-utils.js";
import type { PairingStore } from "./pairing-store.js";

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

export interface MediaHandlerConfig {
  pairings: PairingStore;
  botToken: string;
  mediaEnabled: boolean;
  mediaMaxFileMb: number;
  mediaMaxFileBytes: number;
  mediaVisionMaxFileMb: number;
  mediaVisionMaxFileBytes: number;
  mediaTranscriptMaxChars: number;
  mediaVisionMaxChars: number;
  mediaSttModel: string;
  mediaVisionModel: string;
  mediaOpenAiApiKey: string;
  mediaOpenAiBaseUrl: string;
}

export interface MediaHandlerDeps {
  handleUnpairedMessage(ctx: any, fromId: string): Promise<void>;
  enforcePromptPolicies(ctx: any, userId: string, prompt: string): Promise<boolean>;
  submitJob(ctx: any, prompt: string, kind: "task" | "run", requiresApproval: boolean, metadata?: Record<string, string>): Promise<void>;
}

export function registerMediaHandlers(bot: Bot, cfg: MediaHandlerConfig, deps: MediaHandlerDeps): void {
  bot.on("message:voice", async (ctx) => {
    await handleVoiceOrAudioMessage(ctx, "voice", cfg, deps, bot);
  });

  bot.on("message:audio", async (ctx) => {
    await handleVoiceOrAudioMessage(ctx, "audio", cfg, deps, bot);
  });

  bot.on("message:photo", async (ctx) => {
    try {
      const fromId = parseSender(ctx);
      if (!fromId) {
        return;
      }

      if (!cfg.pairings.isAllowed(fromId)) {
        await deps.handleUnpairedMessage(ctx, fromId);
        return;
      }

      if (!cfg.mediaEnabled) {
        await ctx.reply("Photo understanding is disabled. Set TG_MEDIA_ENABLED=true to enable media processing.");
        return;
      }

      const photo = selectLargestPhoto(ctx.message.photo ?? []);
      if (!photo?.file_id) {
        await ctx.reply("Could not read photo payload from Telegram.");
        return;
      }

      if (typeof photo.file_size === "number" && photo.file_size > cfg.mediaMaxFileBytes) {
        await ctx.reply(`Photo is too large (${formatMb(photo.file_size)} MB). Max allowed is ${cfg.mediaMaxFileMb} MB.`);
        return;
      }

      const file = await downloadTelegramFile(photo.file_id, cfg.botToken, bot);
      if (file.bytes.length > cfg.mediaVisionMaxFileBytes) {
        await ctx.reply(
          `Photo is too large (${formatMb(file.bytes.length)} MB). Max allowed for photo analysis is ${cfg.mediaVisionMaxFileMb} MB.`
        );
        return;
      }

      const caption = (ctx.message.caption ?? "").trim();
      const detectedMimeType = detectImageMimeTypeFromBytes(file.bytes) ?? file.mimeType ?? "image/jpeg";
      if (!isSupportedImageMimeType(detectedMimeType)) {
        await ctx.reply(`Unsupported photo format (${detectedMimeType}). Send JPG, PNG, or WEBP.`);
        return;
      }

      const analysis = await generateImageAnalysis(file.bytes, detectedMimeType, cfg);
      const prompt = buildPhotoPrompt(
        truncateText(analysis, cfg.mediaVisionMaxChars, "photo analysis"),
        caption
      );

      const limited = await deps.enforcePromptPolicies(ctx, fromId, prompt);
      if (!limited) {
        return;
      }

      await deps.submitJob(ctx, prompt, "task", false, {
        telegramInputType: "photo",
        telegramMediaMimeType: file.mimeType ?? "image/jpeg"
      });
    } catch (error) {
      console.warn(`[gateway] photo handler failed: ${formatError(error)}`);
      await ctx.reply(`Request failed: ${formatError(error)}`);
    }
  });
}

async function handleVoiceOrAudioMessage(ctx: any, inputType: "voice" | "audio", cfg: MediaHandlerConfig, deps: MediaHandlerDeps, bot: Bot): Promise<void> {
  try {
    const fromId = String(ctx.from?.id ?? "");
    if (!fromId) {
      return;
    }

    if (!cfg.pairings.isAllowed(fromId)) {
      await deps.handleUnpairedMessage(ctx, fromId);
      return;
    }

    if (!cfg.mediaEnabled) {
      await ctx.reply("Voice and photo understanding is disabled. Set TG_MEDIA_ENABLED=true to enable media processing.");
      return;
    }

    const payload = inputType === "voice" ? ctx.message.voice : ctx.message.audio;
    if (!payload?.file_id) {
      await ctx.reply("Could not read the audio payload from Telegram.");
      return;
    }

    if (typeof payload.file_size === "number" && payload.file_size > cfg.mediaMaxFileBytes) {
      await ctx.reply(`Audio file is too large (${formatMb(payload.file_size)} MB). Max allowed is ${cfg.mediaMaxFileMb} MB.`);
      return;
    }

    const file = await downloadTelegramFile(payload.file_id, cfg.botToken, bot);
    if (file.bytes.length > cfg.mediaMaxFileBytes) {
      await ctx.reply(`Audio file is too large (${formatMb(file.bytes.length)} MB). Max allowed is ${cfg.mediaMaxFileMb} MB.`);
      return;
    }

    const transcript = await transcribeAudio(
      file.bytes,
      normalizeAudioUploadFilename(file.filePath, inputType),
      file.mimeType ?? payload.mime_type ?? "audio/ogg",
      cfg
    );
    const caption = (ctx.message.caption ?? "").trim();
    const prompt = buildVoicePrompt(
      truncateText(transcript, cfg.mediaTranscriptMaxChars, "voice transcript"),
      caption,
      inputType
    );

    const limited = await deps.enforcePromptPolicies(ctx, fromId, prompt);
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

    await deps.submitJob(ctx, prompt, "task", false, metadata);
  } catch (error) {
    console.warn(`[gateway] ${inputType} handler failed: ${formatError(error)}`);
    await ctx.reply(`Request failed: ${formatError(error)}`);
  }
}

async function downloadTelegramFile(fileId: string, botToken: string, bot: Bot): Promise<{ bytes: Buffer; filePath?: string; mimeType?: string }> {
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

async function transcribeAudio(bytes: Buffer, filename: string, mimeType: string, cfg: MediaHandlerConfig): Promise<string> {
  const form = new FormData();
  form.set("model", cfg.mediaSttModel);
  form.set("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

  const response = await fetch(`${cfg.mediaOpenAiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.mediaOpenAiApiKey}`
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

async function generateImageAnalysis(bytes: Buffer, mimeType: string, cfg: MediaHandlerConfig): Promise<string> {
  const candidates = buildImageMimeCandidates(bytes, mimeType);
  let lastError: unknown = undefined;

  for (const candidateMime of candidates) {
    try {
      return await requestImageAnalysis(bytes, candidateMime, cfg);
    } catch (error) {
      lastError = error;
      if (!isRecoverableImageParseError(error)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Photo analysis failed");
}

async function requestImageAnalysis(bytes: Buffer, mimeType: string, cfg: MediaHandlerConfig): Promise<string> {
  const imageDataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;

  const response = await fetch(`${cfg.mediaOpenAiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.mediaOpenAiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: cfg.mediaVisionModel,
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

function isRecoverableImageParseError(error: unknown): boolean {
  const text = formatError(error).toLowerCase();
  return (
    text.includes("image_parse_error") ||
    text.includes("invalid image") ||
    text.includes("unsupported image")
  );
}

