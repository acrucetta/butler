import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

interface PendingRequest {
  resolve: (value: RpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
};

type RpcEvent = Record<string, unknown>;

export interface PiPromptCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolStart?: (toolName: string, raw: RpcEvent) => void;
  onToolEnd?: (toolName: string, raw: RpcEvent) => void;
  onLog?: (message: string) => void;
}

export interface PiRpcSessionOptions {
  piBinary: string;
  cwd: string;
  sessionRoot: string;
  sessionKey: string;
  provider?: string;
  model?: string;
  appendSystemPrompt?: string;
  env?: Record<string, string>;
}

export class PiRpcSession {
  private process: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private listeners: Set<(event: RpcEvent) => void> = new Set();
  private requestId = 0;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly options: PiRpcSessionOptions) {}

  async start(): Promise<void> {
    if (this.process) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startInternal();
    await this.startPromise;
    this.startPromise = null;
  }

  async prompt(prompt: string, callbacks: PiPromptCallbacks = {}): Promise<string> {
    await this.start();

    let finished = false;
    let finishResolve: (() => void) | null = null;
    let finishReject: ((error: Error) => void) | null = null;

    const finishPromise = new Promise<void>((resolve, reject) => {
      finishResolve = resolve;
      finishReject = reject;
    });

    const timeout = setTimeout(() => {
      finishReject?.(new Error("Pi prompt timed out waiting for agent_end"));
    }, 15 * 60 * 1000);

    const unsubscribe = this.onEvent((event) => {
      const eventType = event.type;
      if (eventType === "message_update") {
        const assistantMessageEvent = event.assistantMessageEvent;
        const assistantEvent =
          assistantMessageEvent && typeof assistantMessageEvent === "object"
            ? (assistantMessageEvent as Record<string, unknown>)
            : null;
        if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
          callbacks.onTextDelta?.(assistantEvent.delta);
        }
      }

      if (eventType === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "unknown_tool";
        callbacks.onToolStart?.(toolName, event);
      }

      if (eventType === "tool_execution_end") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "unknown_tool";
        callbacks.onToolEnd?.(toolName, event);
      }

      if (eventType === "agent_end") {
        finished = true;
        finishResolve?.();
      }
    });

    try {
      const response = await this.sendCommand({ type: "prompt", message: prompt }, 60_000);
      if (!response.success) {
        throw new Error(response.error ?? "Pi rejected prompt command");
      }

      await finishPromise;

      if (!finished) {
        throw new Error("Pi stream ended unexpectedly before agent_end");
      }

      const finalTextResp = await this.sendCommand({ type: "get_last_assistant_text" }, 30_000);
      if (!finalTextResp.success) {
        throw new Error(finalTextResp.error ?? "Failed to retrieve assistant output");
      }

      const text = finalTextResp.data?.text;
      if (typeof text !== "string") {
        callbacks.onLog?.("Pi returned non-string result; falling back to buffered deltas");
        return "";
      }

      return text;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
  }

  async abort(): Promise<void> {
    try {
      const response = await this.sendCommand({ type: "abort" }, 10_000);
      if (!response.success) {
        throw new Error(response.error ?? "Abort command failed");
      }
    } catch {
      // If abort fails because process already exited, caller will handle final state.
    }
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;
    this.rl?.close();
    this.rl = null;

    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolvePromise();
      }, 2_000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolvePromise();
      });

      proc.kill("SIGTERM");
    });
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async startInternal(): Promise<void> {
    const sessionDir = resolve(this.options.sessionRoot, sanitizeKey(this.options.sessionKey));
    mkdirSync(dirname(sessionDir), { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const args = ["--mode", "rpc", "--session-dir", sessionDir];
    if (this.options.provider) {
      args.push("--provider", this.options.provider);
    }
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.appendSystemPrompt) {
      const promptFile = resolve(sessionDir, ".system-prompt-append.md");
      writeFileSync(promptFile, this.options.appendSystemPrompt, "utf8");
      args.push("--append-system-prompt", promptFile);
    }

    const binary =
      process.platform === "win32" ? `${this.options.piBinary}.cmd` : this.options.piBinary;

    const child = spawn(binary, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.options.env ?? {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process = child;

    child.stderr.on("data", (chunk: Buffer) => {
      const stderrText = chunk.toString("utf8").trim();
      if (stderrText.length > 0) {
        this.emit({ type: "log", source: "pi-stderr", message: stderrText });
      }
    });

    child.once("exit", (code, signal) => {
      const error = new Error(`Pi process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      this.process = null;
      this.rl?.close();
      this.rl = null;
    });

    this.rl = readline.createInterface({
      input: child.stdout,
      terminal: false
    });

    this.rl.on("line", (line) => {
      this.handleLine(line);
    });

    await sleep(150);

    if (child.exitCode !== null) {
      throw new Error(`Pi process exited immediately with code ${child.exitCode}`);
    }
  }

  private handleLine(line: string): void {
    let parsed: RpcEvent;
    try {
      parsed = JSON.parse(line) as RpcEvent;
    } catch {
      this.emit({ type: "log", source: "pi-stdout-raw", message: line });
      return;
    }

    if (parsed.type === "response" && typeof parsed.id === "string") {
      const pending = this.pending.get(parsed.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(parsed.id);
        pending.resolve(parsed as RpcResponse);
        return;
      }
    }

    if (
      parsed.type === "extension_ui_request" &&
      (parsed.method === "select" ||
        parsed.method === "confirm" ||
        parsed.method === "input" ||
        parsed.method === "editor") &&
      typeof parsed.id === "string"
    ) {
      this.sendRaw({
        type: "extension_ui_response",
        id: parsed.id,
        cancelled: true
      });
    }

    this.emit(parsed);
  }

  private emit(event: RpcEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async sendCommand(command: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
    await this.start();

    const id = `req-${++this.requestId}`;
    const payload = { ...command, id };

    const responsePromise = new Promise<RpcResponse>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`RPC command timed out: ${String(command.type)}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout
      });
    });

    this.sendRaw(payload);
    return responsePromise;
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.process?.stdin.writable) {
      throw new Error("Pi stdin is not writable");
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }
}

export class PiRpcSessionPool {
  private readonly sessions = new Map<string, PiRpcSession>();

  constructor(
    private readonly options: {
      piBinary: string;
      cwd: string;
      sessionRoot: string;
      provider?: string;
      model?: string;
      appendSystemPrompt?: string;
      env?: Record<string, string>;
    }
  ) {}

  getSession(sessionKey: string): PiRpcSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const created = new PiRpcSession({
      ...this.options,
      sessionKey
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
