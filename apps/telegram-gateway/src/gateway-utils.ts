export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/** Join non-empty, non-undefined lines with newlines. Replaces .filter(Boolean).join("\n"). */
export function compactLines(lines: (string | undefined)[]): string {
  return lines.filter((line): line is string => line !== undefined && line !== "").join("\n");
}

/** Parse the Telegram sender ID from a Grammy context, returning null when absent. */
export function parseSender(ctx: { from?: { id?: number | string } }): string | null {
  const id = ctx.from?.id;
  return id ? String(id) : null;
}
