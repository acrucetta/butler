import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface PendingPairing {
  code: string;
  createdAt: string;
}

interface PairingState {
  allowedUserIds: string[];
  pendingByUserId: Record<string, PendingPairing>;
}

const PAIRING_TTL_MS = 60 * 60 * 1000;

export class PairingStore {
  private state: PairingState;
  private ownerIds: Set<string>;

  constructor(
    private readonly filePath: string,
    ownerIds: string[],
    allowFrom: string[]
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.ownerIds = new Set(ownerIds);
    this.state = this.load();

    for (const ownerId of ownerIds) {
      this.addAllowed(ownerId);
    }
    for (const userId of allowFrom) {
      this.addAllowed(userId);
    }

    this.pruneExpired();
    this.save();
  }

  isOwner(userId: string): boolean {
    return this.ownerIds.has(userId);
  }

  isAllowed(userId: string): boolean {
    return this.state.allowedUserIds.includes(userId);
  }

  issuePairingCode(userId: string): string {
    this.pruneExpired();

    const existing = this.state.pendingByUserId[userId];
    if (existing) {
      return existing.code;
    }

    const code = generateCode();
    this.state.pendingByUserId[userId] = {
      code,
      createdAt: new Date().toISOString()
    };

    this.save();
    return code;
  }

  approveCode(code: string): { userId: string } | null {
    this.pruneExpired();

    const normalized = code.trim().toUpperCase();
    for (const [userId, pending] of Object.entries(this.state.pendingByUserId)) {
      if (pending.code === normalized) {
        delete this.state.pendingByUserId[userId];
        this.addAllowed(userId);
        this.save();
        return { userId };
      }
    }

    return null;
  }

  listPending(): Array<{ userId: string; code: string; createdAt: string }> {
    this.pruneExpired();
    this.save();

    return Object.entries(this.state.pendingByUserId)
      .map(([userId, pending]) => ({
        userId,
        code: pending.code,
        createdAt: pending.createdAt
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private addAllowed(userId: string): void {
    if (!userId) return;
    if (!this.state.allowedUserIds.includes(userId)) {
      this.state.allowedUserIds.push(userId);
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [userId, pending] of Object.entries(this.state.pendingByUserId)) {
      const createdAt = Date.parse(pending.createdAt);
      if (!Number.isFinite(createdAt)) {
        delete this.state.pendingByUserId[userId];
        continue;
      }

      if (now - createdAt > PAIRING_TTL_MS) {
        delete this.state.pendingByUserId[userId];
      }
    }
  }

  private load(): PairingState {
    if (!existsSync(this.filePath)) {
      return {
        allowedUserIds: [],
        pendingByUserId: {}
      };
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PairingState;
      return {
        allowedUserIds: parsed.allowedUserIds ?? [],
        pendingByUserId: parsed.pendingByUserId ?? {}
      };
    } catch {
      return {
        allowedUserIds: [],
        pendingByUserId: {}
      };
    }
  }

  private save(): void {
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(temp, this.filePath);
  }
}

function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let i = 0; i < 6; i += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)] ?? "X";
  }
  return value;
}
