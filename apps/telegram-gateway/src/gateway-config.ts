import { resolveGatewayDataPaths, type GatewayDataPaths } from "./gateway-paths.js";

export interface GatewayConfig {
  botToken: string;
  orchestratorBaseUrl: string;
  gatewayToken: string;
  jobPollMs: number;
  promptMaxChars: number;
  rateLimitPerMinute: number;
  runOwnerOnly: boolean;
  approveOwnerOnly: boolean;
  allowRequesterAbort: boolean;
  notifyToolEvents: boolean;
  onlyAgentOutput: boolean;
  agentMarkdownV2: boolean;
  typingEnabled: boolean;
  typingHeartbeatMs: number;
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
  proactiveDeliveryPollMs: number;
  pollingRetryBaseMs: number;
  pollingRetryMaxMs: number;
  pollingConflictMaxRetries: number;
  owners: string[];
  allowFrom: string[];
  gatewayDataPaths: GatewayDataPaths;
  pairingsFile: string;
  sessionsFile: string;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const mediaMaxFileMb = parsePositiveInt(env.TG_MEDIA_MAX_FILE_MB, 20);
  const mediaVisionMaxFileMb = parsePositiveInt(env.TG_MEDIA_VISION_MAX_FILE_MB, 8);
  const mediaOpenAiApiKey = env.OPENAI_API_KEY?.trim() || "";
  const owners = splitCsv(env.TG_OWNER_IDS ?? "");
  const gatewayDataPaths = resolveGatewayDataPaths({
    pairingsFileEnv: env.TG_PAIRINGS_FILE,
    sessionsFileEnv: env.TG_SESSIONS_FILE
  });

  if (owners.length === 0) {
    throw new Error("TG_OWNER_IDS must include at least one Telegram user ID");
  }

  if (parseBoolean(env.TG_MEDIA_ENABLED, true) && !mediaOpenAiApiKey) {
    throw new Error("TG_MEDIA_ENABLED=true requires OPENAI_API_KEY");
  }

  return {
    botToken: requireEnv("TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN),
    orchestratorBaseUrl: env.ORCH_BASE_URL ?? "http://127.0.0.1:8787",
    gatewayToken: requireSecret("ORCH_GATEWAY_TOKEN", env.ORCH_GATEWAY_TOKEN),
    jobPollMs: parsePositiveInt(env.TG_JOB_POLL_MS, 2_000),
    promptMaxChars: parsePositiveInt(env.TG_PROMPT_MAX_CHARS, 8_000),
    rateLimitPerMinute: parsePositiveInt(env.TG_RATE_LIMIT_PER_MIN, 12),
    runOwnerOnly: parseBoolean(env.TG_RUN_OWNER_ONLY, true),
    approveOwnerOnly: parseBoolean(env.TG_APPROVE_OWNER_ONLY, true),
    allowRequesterAbort: parseBoolean(env.TG_ALLOW_REQUESTER_ABORT, true),
    notifyToolEvents: parseBoolean(env.TG_NOTIFY_TOOL_EVENTS, false),
    onlyAgentOutput: parseBoolean(env.TG_ONLY_AGENT_OUTPUT, true),
    agentMarkdownV2: parseBoolean(env.TG_AGENT_MARKDOWNV2, true),
    typingEnabled: parseBoolean(env.TG_TYPING_ENABLED, true),
    typingHeartbeatMs: Math.max(1_000, parsePositiveInt(env.TG_TYPING_HEARTBEAT_MS, 4_000)),
    mediaEnabled: parseBoolean(env.TG_MEDIA_ENABLED, true),
    mediaMaxFileMb,
    mediaMaxFileBytes: mediaMaxFileMb * 1024 * 1024,
    mediaVisionMaxFileMb,
    mediaVisionMaxFileBytes: mediaVisionMaxFileMb * 1024 * 1024,
    mediaTranscriptMaxChars: parsePositiveInt(env.TG_MEDIA_TRANSCRIPT_MAX_CHARS, 6_000),
    mediaVisionMaxChars: parsePositiveInt(env.TG_MEDIA_VISION_MAX_CHARS, 4_000),
    mediaSttModel: env.TG_MEDIA_STT_MODEL?.trim() || "gpt-4o-mini-transcribe",
    mediaVisionModel: env.TG_MEDIA_VISION_MODEL?.trim() || "gpt-5-mini",
    mediaOpenAiApiKey,
    mediaOpenAiBaseUrl: normalizeOpenAiBaseUrl(env.OPENAI_BASE_URL),
    proactiveDeliveryPollMs: parsePositiveInt(env.TG_PROACTIVE_DELIVERY_POLL_MS, 3_000),
    pollingRetryBaseMs: parsePositiveInt(env.TG_POLL_RETRY_BASE_MS, 1_000),
    pollingRetryMaxMs: parsePositiveInt(env.TG_POLL_RETRY_MAX_MS, 30_000),
    pollingConflictMaxRetries: parsePositiveInt(env.TG_POLLING_CONFLICT_MAX_RETRIES, 10),
    owners,
    allowFrom: splitCsv(env.TG_ALLOW_FROM ?? ""),
    gatewayDataPaths,
    pairingsFile: gatewayDataPaths.pairingsFile,
    sessionsFile: gatewayDataPaths.sessionsFile
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value.trim();
}

function requireSecret(name: string, value: string | undefined): string {
  const resolved = requireEnv(name, value);
  if (resolved.length < 16) {
    throw new Error(`${name} must be at least 16 characters`);
  }
  return resolved;
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

function normalizeOpenAiBaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    return "https://api.openai.com/v1";
  }
  return value.replace(/\/+$/g, "");
}
