import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface MemorySearchHit {
  path: string;
  line: number;
  text: string;
  score: number;
}

interface MemoryLedgerEntry {
  id: string;
  ts: string;
  action: "store";
  scope: "daily" | "durable";
  path: string;
  text: string;
}

export class MemoryService {
  private readonly durablePath: string;
  private readonly dailyDir: string;

  constructor(
    memoryRoot: string,
    private readonly ledgerPath: string
  ) {
    this.durablePath = resolve(memoryRoot, "MEMORY.md");
    this.dailyDir = resolve(memoryRoot, "memory");
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    mkdirSync(this.dailyDir, { recursive: true });
  }

  search(query: string, limit: number): MemorySearchHit[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const cappedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const queryTerms = normalized.split(/\s+/).filter(Boolean);
    const files = [...this.listDailyFilesNewestFirst(), this.durablePath];
    const hits: MemorySearchHit[] = [];

    for (const filePath of files) {
      const scored = scoreFile(filePath, normalized, queryTerms);
      hits.push(...scored);
    }

    return hits
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return recencyBoost(b.path) - recencyBoost(a.path);
      })
      .slice(0, cappedLimit);
  }

  store(text: string, scope: "daily" | "durable"): { path: string; line: number } {
    const clean = text.trim();
    if (!clean) {
      throw new Error("memory text cannot be empty");
    }

    const ts = new Date().toISOString();
    const path = scope === "durable" ? this.durablePath : this.dailyPathFor(new Date());
    this.ensureFile(path, scope);

    const linePrefix = scope === "durable" ? "- " : `- [${ts.slice(11, 19)}] `;
    const lineText = `${linePrefix}${clean}`;
    const existing = readFileSync(path, "utf8");
    const line = existing.split(/\r?\n/).length + 1;
    const next = `${existing.endsWith("\n") ? existing : `${existing}\n`}${lineText}\n`;
    writeFileSync(path, next, "utf8");

    this.appendLedger({
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      ts,
      action: "store",
      scope,
      path,
      text: clean
    });

    return { path, line };
  }

  ledger(limit: number): MemoryLedgerEntry[] {
    const cappedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    if (!existsSync(this.ledgerPath)) {
      return [];
    }

    const raw = readFileSync(this.ledgerPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const parsed: MemoryLedgerEntry[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as MemoryLedgerEntry;
        parsed.push(value);
      } catch {
        continue;
      }
    }
    return parsed.slice(-cappedLimit).reverse();
  }

  private listDailyFilesNewestFirst(): string[] {
    if (!existsSync(this.dailyDir)) {
      return [];
    }

    return readdirSync(this.dailyDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort((a, b) => b.localeCompare(a))
      .map((name) => resolve(this.dailyDir, name));
  }

  private dailyPathFor(now: Date): string {
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return resolve(this.dailyDir, `${yyyy}-${mm}-${dd}.md`);
  }

  private ensureFile(path: string, scope: "daily" | "durable"): void {
    if (existsSync(path)) {
      return;
    }

    mkdirSync(dirname(path), { recursive: true });
    if (scope === "durable") {
      writeFileSync(path, "# MEMORY\n\nLong-term durable facts and user preferences.\n", "utf8");
      return;
    }
    const name = path.split("/").at(-1)?.replace(".md", "") ?? "daily";
    writeFileSync(path, `# ${name}\n\nDaily memory notes.\n`, "utf8");
  }

  private appendLedger(entry: MemoryLedgerEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    const existing = existsSync(this.ledgerPath) ? readFileSync(this.ledgerPath, "utf8") : "";
    writeFileSync(this.ledgerPath, `${existing}${line}`, "utf8");
  }
}

function scoreFile(path: string, normalizedQuery: string, queryTerms: string[]): MemorySearchHit[] {
  if (!existsSync(path)) {
    return [];
  }

  const content = readFileSync(path, "utf8");
  const lines = content.split(/\r?\n/);
  const hits: MemorySearchHit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? "";
    const lower = text.toLowerCase();
    const score = relevanceScore(lower, normalizedQuery, queryTerms);
    if (score <= 0) {
      continue;
    }
    hits.push({
      path,
      line: i + 1,
      text: text.trim(),
      score
    });
  }

  return hits.sort((a, b) => b.score - a.score);
}

function relevanceScore(text: string, phrase: string, terms: string[]): number {
  if (!phrase) {
    return 0;
  }

  let score = 0;
  if (text.includes(phrase)) {
    score += 10;
  }

  for (const term of terms) {
    if (!term) {
      continue;
    }
    let from = 0;
    for (;;) {
      const idx = text.indexOf(term, from);
      if (idx === -1) {
        break;
      }
      score += 2;
      from = idx + term.length;
    }
  }

  return score;
}

function recencyBoost(path: string): number {
  const name = path.split("/").at(-1) ?? "";
  const match = name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!match || !match[1]) {
    return 0;
  }

  const ts = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(ts) ? ts : 0;
}
