import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface MemorySemanticHit {
  path: string;
  line: number;
  text: string;
  score: number;
}

interface SourceSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
}

interface ChunkRecord {
  id: string;
  path: string;
  line: number;
  text: string;
  embedding: number[];
}

interface IndexPayload {
  version: 1;
  provider: "local";
  model: "local-hash-v1";
  builtAt: string;
  sources: SourceSnapshot[];
  chunks: ChunkRecord[];
}

export interface MemorySemanticIndexStatus {
  provider: "local";
  model: "local-hash-v1";
  chunks: number;
  lastIndexedAt?: string;
  stale: boolean;
}

interface MemorySemanticIndexOptions {
  memoryRoot: string;
  indexFile: string;
}

const VECTOR_DIMS = 256;

export class MemorySemanticIndex {
  private readonly durablePath: string;
  private readonly dailyDir: string;
  private payload: IndexPayload | null = null;

  constructor(private readonly options: MemorySemanticIndexOptions) {
    this.durablePath = resolve(options.memoryRoot, "MEMORY.md");
    this.dailyDir = resolve(options.memoryRoot, "memory");
    mkdirSync(dirname(options.indexFile), { recursive: true });
    this.payload = this.loadIndex();
  }

  status(): MemorySemanticIndexStatus {
    const payload = this.payload;
    return {
      provider: "local",
      model: "local-hash-v1",
      chunks: payload?.chunks.length ?? 0,
      lastIndexedAt: payload?.builtAt,
      stale: this.isStale()
    };
  }

  async rebuild(): Promise<{ chunks: number; sources: number; builtAt: string }> {
    const sources = this.listSources();
    const chunks: ChunkRecord[] = [];

    for (const source of sources) {
      const fileChunks = this.chunkFile(source.path);
      chunks.push(...fileChunks);
    }

    const payload: IndexPayload = {
      version: 1,
      provider: "local",
      model: "local-hash-v1",
      builtAt: new Date().toISOString(),
      sources,
      chunks
    };

    this.persist(payload);
    this.payload = payload;
    return {
      chunks: payload.chunks.length,
      sources: payload.sources.length,
      builtAt: payload.builtAt
    };
  }

  async search(query: string, limit: number): Promise<MemorySemanticHit[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    if (!this.payload || this.isStale()) {
      await this.rebuild();
    }
    const payload = this.payload;
    if (!payload) {
      return [];
    }

    const capped = Math.max(1, Math.min(50, Math.floor(limit)));
    const queryEmbedding = embedText(trimmed);
    const normalized = trimmed.toLowerCase();
    const terms = normalized.split(/\s+/).filter(Boolean);

    const hits = payload.chunks
      .map((chunk) => {
        const cos = cosineSimilarity(queryEmbedding, chunk.embedding);
        const lexical = lexicalScore(chunk.text.toLowerCase(), normalized, terms);
        const score = cos * 0.8 + lexical * 0.2 + recencyBoost(chunk.path) * 0.0000000000001;
        return {
          path: chunk.path,
          line: chunk.line,
          text: chunk.text,
          score
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, capped);

    return hits;
  }

  private isStale(): boolean {
    if (!this.payload) {
      return true;
    }
    const current = this.listSources();
    if (current.length !== this.payload.sources.length) {
      return true;
    }
    const byPath = new Map(current.map((item) => [item.path, item]));
    for (const source of this.payload.sources) {
      const next = byPath.get(source.path);
      if (!next) {
        return true;
      }
      if (next.mtimeMs !== source.mtimeMs || next.size !== source.size) {
        return true;
      }
    }
    return false;
  }

  private listSources(): SourceSnapshot[] {
    const files: string[] = [];
    if (existsSync(this.durablePath)) {
      files.push(this.durablePath);
    }
    if (existsSync(this.dailyDir)) {
      for (const name of readdirSync(this.dailyDir)) {
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
          files.push(resolve(this.dailyDir, name));
        }
      }
    }

    return files
      .map((path) => {
        const stat = statSync(path);
        return { path, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private chunkFile(path: string): ChunkRecord[] {
    if (!existsSync(path)) {
      return [];
    }
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/);
    const chunks: ChunkRecord[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? "";
      const lineText = raw.trim();
      if (!lineText || lineText.startsWith("#")) {
        continue;
      }
      chunks.push({
        id: `${path}:${i + 1}`,
        path,
        line: i + 1,
        text: lineText,
        embedding: embedText(lineText)
      });
    }
    return chunks;
  }

  private loadIndex(): IndexPayload | null {
    if (!existsSync(this.options.indexFile)) {
      return null;
    }

    try {
      const raw = readFileSync(this.options.indexFile, "utf8");
      const parsed = JSON.parse(raw) as IndexPayload;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.chunks)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private persist(payload: IndexPayload): void {
    writeFileSync(this.options.indexFile, `${JSON.stringify(payload)}\n`, "utf8");
  }
}

function embedText(text: string): number[] {
  const out = new Array<number>(VECTOR_DIMS).fill(0);
  const normalized = text.toLowerCase();
  const terms = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  for (const term of terms) {
    addToken(out, term, 1);
  }
  for (const tri of charTrigrams(normalized)) {
    addToken(out, tri, 0.5);
  }
  return normalize(out);
}

function addToken(vec: number[], token: string, weight: number): void {
  const hash = fnv1a(token);
  const a = hash % VECTOR_DIMS;
  const b = ((hash >>> 8) ^ hash) % VECTOR_DIMS;
  vec[a] = (vec[a] ?? 0) + weight;
  vec[b] = (vec[b] ?? 0) + weight * 0.7;
}

function charTrigrams(text: string): string[] {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length < 3) {
    return compact ? [compact] : [];
  }
  const out: string[] = [];
  for (let i = 0; i <= compact.length - 3; i += 1) {
    out.push(compact.slice(i, i + 3));
  }
  return out;
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) {
    return vec;
  }
  return vec.map((value) => value / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function lexicalScore(text: string, phrase: string, terms: string[]): number {
  let score = 0;
  if (text.includes(phrase)) {
    score += 8;
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
      score += 1;
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

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
