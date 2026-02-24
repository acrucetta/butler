/**
 * Embedded Pi session — wraps the Pi SDK's `AgentSession` directly in-process.
 *
 * Runs the agent loop inside the same Node.js process, providing:
 * - Full control over conversation history, compaction, and tool interception
 * - No IPC overhead or subprocess lifecycle management
 * - Direct access to session events via the SDK's subscribe API
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  ModelRegistry
} from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  codingTools,
  type ToolDefinition
} from "@mariozechner/pi-coding-agent";
import { limitHistoryTurns } from "./history.js";
import type { PiPromptCallbacks, PiSession, PiSessionPool } from "./pi-session.js";

export interface PiEmbeddedSessionOptions {
  cwd: string;
  sessionDir: string;
  provider?: string;
  model?: string;
  appendSystemPrompt?: string;
  env?: Record<string, string>;
  /** Max user turns to keep in history. Older turns are trimmed before each prompt. */
  historyLimit?: number;
  /** Full system prompt override applied before each prompt. */
  systemPromptOverride?: string;
  /** Override for testing — inject a pre-built AuthStorage. */
  authStorage?: AuthStorage;
  /** Override for testing — inject a pre-built ModelRegistry. */
  modelRegistry?: ModelRegistry;
  /** Custom tools (e.g. MCP skill tools) registered alongside built-in codingTools. */
  customTools?: ToolDefinition[];
}

export class PiEmbeddedSession implements PiSession {
  private session: AgentSession | null = null;
  private startPromise: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private currentSystemPrompt: string | undefined;

  constructor(private readonly options: PiEmbeddedSessionOptions) {
    this.currentSystemPrompt = options.systemPromptOverride;
  }

  async start(): Promise<void> {
    if (this.session) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startInternal();
    await this.startPromise;
    this.startPromise = null;
  }

  async prompt(text: string, callbacks: PiPromptCallbacks = {}): Promise<string> {
    await this.start();

    if (!this.session) {
      throw new Error("PiEmbeddedSession: session not initialized");
    }

    let finished = false;
    let finishResolve: (() => void) | null = null;
    let finishReject: ((error: Error) => void) | null = null;

    const finishPromise = new Promise<void>((res, rej) => {
      finishResolve = res;
      finishReject = rej;
    });

    const timeout = setTimeout(() => {
      finishReject?.(new Error("Pi embedded prompt timed out waiting for agent_end"));
    }, 15 * 60 * 1000);

    // Override system prompt per-run if configured. This replaces the SDK's
    // default prompt with our custom one (personality + memory + skills).
    // Lock _rebuildSystemPrompt so the SDK doesn't overwrite it.
    if (this.currentSystemPrompt) {
      const prompt = this.currentSystemPrompt;
      this.session.agent.setSystemPrompt(prompt);
      const mutable = this.session as unknown as {
        _baseSystemPrompt?: string;
        _rebuildSystemPrompt?: (toolNames: string[]) => string;
      };
      mutable._baseSystemPrompt = prompt;
      mutable._rebuildSystemPrompt = () => prompt;
    }

    // Trim old history before prompting to keep context window manageable.
    // Uses agent.replaceMessages() like OpenClaw does after limitHistoryTurns().
    if (this.options.historyLimit) {
      const messages = this.session.messages;
      const trimmed = limitHistoryTurns(messages, this.options.historyLimit);
      if (trimmed.length < messages.length) {
        this.session.agent.replaceMessages(trimmed);
        callbacks.onLog?.(`History trimmed: ${messages.length} → ${trimmed.length} messages (limit=${this.options.historyLimit} turns)`);
      }
    }

    // Truncate oversized tool results before prompting. Individual tool results
    // that consume >30% of the context window bloat history and break compaction.
    this.truncateOversizedToolResults(callbacks);

    let compactionTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = this.session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_update") {
        const assistantEvent = (event as Record<string, unknown>).assistantMessageEvent;
        if (
          assistantEvent &&
          typeof assistantEvent === "object" &&
          (assistantEvent as Record<string, unknown>).type === "text_delta"
        ) {
          const delta = (assistantEvent as Record<string, unknown>).delta;
          if (typeof delta === "string") {
            callbacks.onTextDelta?.(delta);
          }
        }
      }

      if (event.type === "tool_execution_start") {
        const toolName =
          "toolName" in event && typeof event.toolName === "string"
            ? event.toolName
            : "unknown_tool";
        callbacks.onToolStart?.(toolName, event as unknown as Record<string, unknown>);
      }

      if (event.type === "tool_execution_end") {
        const toolName =
          "toolName" in event && typeof event.toolName === "string"
            ? event.toolName
            : "unknown_tool";
        callbacks.onToolEnd?.(toolName, event as unknown as Record<string, unknown>);
      }

      if (event.type === "auto_compaction_start") {
        callbacks.onLog?.(`Auto-compaction started (reason=${event.reason})`);
        // Safety timeout: abort compaction if it takes longer than 5 minutes
        compactionTimer = setTimeout(() => {
          callbacks.onLog?.("Auto-compaction safety timeout (5min) — aborting");
          this.session?.abortCompaction();
        }, 5 * 60 * 1000);
      }

      if (event.type === "auto_compaction_end") {
        if (compactionTimer) {
          clearTimeout(compactionTimer);
          compactionTimer = null;
        }
        const status = event.aborted ? "aborted" : event.result ? "completed" : "failed";
        callbacks.onLog?.(`Auto-compaction ${status}`);
      }

      if (event.type === "agent_end") {
        finished = true;
        finishResolve?.();
      }
    });

    try {
      await this.session.prompt(text);
      await finishPromise;

      if (!finished) {
        throw new Error("Pi embedded session ended unexpectedly before agent_end");
      }

      const result = this.session.getLastAssistantText();
      return result ?? "";
    } finally {
      clearTimeout(timeout);
      if (compactionTimer) clearTimeout(compactionTimer);
      unsub();
    }
  }

  setSystemPrompt(prompt: string): void {
    this.currentSystemPrompt = prompt;
  }

  setActiveTools(toolNames: string[]): void {
    if (this.session) {
      this.session.setActiveToolsByName(toolNames);
    }
  }

  getAllToolNames(): string[] {
    if (!this.session) return [];
    return this.session.getActiveToolNames();
  }

  async steer(text: string): Promise<void> {
    if (this.session && this.session.isStreaming) {
      await this.session.steer(text);
    }
  }

  isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }

  async abort(): Promise<void> {
    if (this.session) {
      await this.session.abort();
    }
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }

  /**
   * Truncate individual tool results that are disproportionately large.
   * A single oversized tool result (e.g., a huge file read) can consume most
   * of the context window and cause compaction to fail.
   */
  private truncateOversizedToolResults(callbacks: PiPromptCallbacks): void {
    if (!this.session) return;

    const MAX_TOOL_RESULT_CHARS = 100_000; // ~25K tokens
    const messages = this.session.messages;
    let mutated = false;

    for (const msg of messages) {
      // toolResult messages have content arrays; check each item
      if (msg.role !== "toolResult") continue;
      const raw = msg as unknown as { content: unknown };
      if (typeof raw.content === "string" && raw.content.length > MAX_TOOL_RESULT_CHARS) {
        raw.content = raw.content.slice(0, MAX_TOOL_RESULT_CHARS) +
          `\n\n[truncated: original was ${raw.content.length} chars]`;
        mutated = true;
      }
    }

    if (mutated) {
      this.session.agent.replaceMessages(messages);
      callbacks.onLog?.("Truncated oversized tool results in session history");
    }
  }

  private async startInternal(): Promise<void> {
    mkdirSync(this.options.sessionDir, { recursive: true });

    // Inject profile env vars into process.env so the SDK picks them up.
    if (this.options.env) {
      for (const [key, value] of Object.entries(this.options.env)) {
        process.env[key] = value;
      }
    }

    const sessionManager = SessionManager.continueRecent(
      this.options.cwd,
      this.options.sessionDir
    );

    // Use DefaultResourceLoader to inject appendSystemPrompt into the
    // system prompt (personality/memory context from SOUL.md, MEMORY.md).
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.cwd,
      ...(this.options.appendSystemPrompt
        ? { appendSystemPrompt: this.options.appendSystemPrompt }
        : {})
    });

    const sessionOptions: Parameters<typeof createAgentSession>[0] = {
      cwd: this.options.cwd,
      sessionManager,
      resourceLoader,
      tools: codingTools,
      ...(this.options.customTools && this.options.customTools.length > 0
        ? { customTools: this.options.customTools }
        : {})
    };

    // If provider+model specified, resolve via ModelRegistry
    if (this.options.provider && this.options.model) {
      if (this.options.modelRegistry) {
        const model = this.options.modelRegistry.find(
          this.options.provider,
          this.options.model
        );
        if (model) {
          sessionOptions.model = model;
        }
      }
      if (this.options.authStorage) {
        sessionOptions.authStorage = this.options.authStorage;
      }
      if (this.options.modelRegistry) {
        sessionOptions.modelRegistry = this.options.modelRegistry;
      }
    }

    const { session } = await createAgentSession(sessionOptions);
    this.session = session;

    // Enable auto-compaction so long conversations don't overflow context
    session.setAutoCompactionEnabled(true);
  }
}

export interface PiEmbeddedSessionPoolOptions {
  cwd: string;
  sessionRoot: string;
  provider?: string;
  model?: string;
  appendSystemPrompt?: string;
  env?: Record<string, string>;
  historyLimit?: number;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  customTools?: ToolDefinition[];
}

export class PiEmbeddedSessionPool implements PiSessionPool {
  private readonly sessions = new Map<string, PiEmbeddedSession>();

  constructor(private readonly options: PiEmbeddedSessionPoolOptions) {}

  getSession(sessionKey: string): PiEmbeddedSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const sessionDir = resolve(this.options.sessionRoot, sanitizeKey(sessionKey));

    const created = new PiEmbeddedSession({
      cwd: this.options.cwd,
      sessionDir,
      provider: this.options.provider,
      model: this.options.model,
      appendSystemPrompt: this.options.appendSystemPrompt,
      env: this.options.env,
      historyLimit: this.options.historyLimit,
      authStorage: this.options.authStorage,
      modelRegistry: this.options.modelRegistry,
      customTools: this.options.customTools
    });

    this.sessions.set(sessionKey, created);
    return created;
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.stop();
    }
    this.sessions.clear();
  }
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
