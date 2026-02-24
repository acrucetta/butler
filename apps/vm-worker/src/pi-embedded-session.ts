/**
 * Embedded Pi session — wraps the Pi SDK's `AgentSession` directly in-process.
 *
 * Unlike PiRpcSession (which spawns `pi --mode rpc` as a child process), this
 * runs the agent loop inside the same Node.js process.  Advantages:
 * - Full control over conversation history, compaction, and tool interception
 * - No IPC overhead or subprocess lifecycle management
 * - Direct access to session events without JSON-over-stdio parsing
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
  SessionManager,
  codingTools
} from "@mariozechner/pi-coding-agent";
import type { PiPromptCallbacks, PiSession, PiSessionPool } from "./pi-session.js";

export interface PiEmbeddedSessionOptions {
  cwd: string;
  sessionDir: string;
  provider?: string;
  model?: string;
  appendSystemPrompt?: string;
  env?: Record<string, string>;
  /** Override for testing — inject a pre-built AuthStorage. */
  authStorage?: AuthStorage;
  /** Override for testing — inject a pre-built ModelRegistry. */
  modelRegistry?: ModelRegistry;
}

export class PiEmbeddedSession implements PiSession {
  private session: AgentSession | null = null;
  private startPromise: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: PiEmbeddedSessionOptions) {}

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
      }

      if (event.type === "auto_compaction_end") {
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
      unsub();
    }
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

  private async startInternal(): Promise<void> {
    mkdirSync(this.options.sessionDir, { recursive: true });

    // Inject profile env vars into process.env so the SDK picks them up
    // (same approach as RPC mode which passes them via spawn env).
    if (this.options.env) {
      for (const [key, value] of Object.entries(this.options.env)) {
        process.env[key] = value;
      }
    }

    const sessionManager = SessionManager.continueRecent(
      this.options.cwd,
      this.options.sessionDir
    );

    const sessionOptions: Parameters<typeof createAgentSession>[0] = {
      cwd: this.options.cwd,
      sessionManager,
      tools: codingTools
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
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
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
      authStorage: this.options.authStorage,
      modelRegistry: this.options.modelRegistry
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
