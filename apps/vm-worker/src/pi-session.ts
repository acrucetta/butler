/**
 * Shared interface for Pi execution backends (RPC subprocess and embedded SDK).
 *
 * Both PiRpcSession and PiEmbeddedSession implement PiSession so that the
 * model-routing layer and job loop are completely agnostic of the execution
 * mode.
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
