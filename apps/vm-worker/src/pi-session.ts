/**
 * Shared interface for Pi session execution.
 *
 * PiEmbeddedSession implements PiSession so that the model-routing layer
 * and job loop are agnostic of internal session mechanics.
 */

export interface PiPromptCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolStart?: (toolName: string, raw: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string, raw: Record<string, unknown>) => void;
  onLog?: (message: string) => void;
}

export interface PiSession {
  prompt(text: string, callbacks?: PiPromptCallbacks): Promise<string>;
  /** Queue a message into the active prompt turn (delivered after current tool finishes). */
  steer(text: string): Promise<void>;
  /** True when the session is actively streaming a response. */
  isStreaming(): boolean;
  /** Update the system prompt for subsequent runs (refreshes personality/memory). */
  setSystemPrompt(prompt: string): void;
  abort(): Promise<void>;
  stop(): Promise<void>;
}

export interface PiSessionPool {
  getSession(sessionKey: string): PiSession;
  shutdown(): Promise<void>;
}
