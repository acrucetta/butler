import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface SessionEntry {
  sessionKey: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
  lastResetAt: string;
}

interface SessionState {
  sessionsByRouteKey: Record<string, SessionEntry>;
}

export interface SessionInfo {
  routeKey: string;
  chatId: string;
  threadId?: string;
  sessionKey: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
  lastResetAt: string;
}

export class SessionStore {
  private state: SessionState;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.state = this.load();
    this.save();
  }

  getSession(chatId: string, threadId?: string): SessionInfo {
    const routeKey = buildRouteKey(chatId, threadId);
    const existing = this.state.sessionsByRouteKey[routeKey];
    if (existing) {
      return materialize(routeKey, existing);
    }

    const now = new Date().toISOString();
    const created: SessionEntry = {
      sessionKey: buildSessionKey(chatId, threadId, 1),
      generation: 1,
      createdAt: now,
      updatedAt: now,
      lastResetAt: now
    };

    this.state.sessionsByRouteKey[routeKey] = created;
    this.save();
    return materialize(routeKey, created);
  }

  resetSession(chatId: string, threadId?: string): SessionInfo {
    const routeKey = buildRouteKey(chatId, threadId);
    const previous = this.state.sessionsByRouteKey[routeKey] ?? this.getSession(chatId, threadId);
    const generation = previous.generation + 1;
    const now = new Date().toISOString();

    const updated: SessionEntry = {
      sessionKey: buildSessionKey(chatId, threadId, generation),
      generation,
      createdAt: previous.createdAt,
      updatedAt: now,
      lastResetAt: now
    };

    this.state.sessionsByRouteKey[routeKey] = updated;
    this.save();
    return materialize(routeKey, updated);
  }

  touchSession(chatId: string, threadId?: string): SessionInfo {
    const routeKey = buildRouteKey(chatId, threadId);
    const existing = this.state.sessionsByRouteKey[routeKey] ?? this.getSession(chatId, threadId);
    const now = new Date().toISOString();

    const touched: SessionEntry = {
      ...existing,
      updatedAt: now
    };

    this.state.sessionsByRouteKey[routeKey] = touched;
    this.save();
    return materialize(routeKey, touched);
  }

  private load(): SessionState {
    if (!existsSync(this.filePath)) {
      return { sessionsByRouteKey: {} };
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionState;
      return {
        sessionsByRouteKey: parsed.sessionsByRouteKey ?? {}
      };
    } catch {
      return { sessionsByRouteKey: {} };
    }
  }

  private save(): void {
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(temp, this.filePath);
  }
}

function materialize(routeKey: string, entry: SessionEntry): SessionInfo {
  const parsed = parseRouteKey(routeKey);
  return {
    routeKey,
    chatId: parsed.chatId,
    threadId: parsed.threadId,
    sessionKey: entry.sessionKey,
    generation: entry.generation,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastResetAt: entry.lastResetAt
  };
}

function buildRouteKey(chatId: string, threadId?: string): string {
  return threadId ? `chat:${chatId}:thread:${threadId}` : `chat:${chatId}`;
}

function buildSessionKey(chatId: string, threadId: string | undefined, generation: number): string {
  const base = threadId ? `telegram:${chatId}:thread:${threadId}` : `telegram:${chatId}`;
  return `${base}:v${generation}`;
}

function parseRouteKey(routeKey: string): { chatId: string; threadId?: string } {
  const parts = routeKey.split(":");
  if (parts.length === 2 && parts[0] === "chat" && parts[1]) {
    return { chatId: parts[1] };
  }

  if (parts.length === 4 && parts[0] === "chat" && parts[2] === "thread" && parts[1] && parts[3]) {
    return { chatId: parts[1], threadId: parts[3] };
  }

  return { chatId: routeKey };
}
