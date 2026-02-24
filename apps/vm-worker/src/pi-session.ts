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
  abort(): Promise<void>;
  stop(): Promise<void>;
}

export interface PiSessionPool {
  getSession(sessionKey: string): PiSession;
  shutdown(): Promise<void>;
}
