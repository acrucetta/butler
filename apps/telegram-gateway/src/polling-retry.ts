export function isTelegramPollingConflictError(error: unknown): boolean {
  const candidate = error as {
    error_code?: unknown;
    description?: unknown;
    message?: unknown;
  } | null;

  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  if (candidate.error_code === 409) {
    return true;
  }

  const description = typeof candidate.description === "string" ? candidate.description.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return (
    description.includes("terminated by other getupdates request") ||
    message.includes("terminated by other getupdates request")
  );
}

export function computePollingRetryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  const normalizedBase = Math.max(100, Math.trunc(baseMs));
  const normalizedMax = Math.max(normalizedBase, Math.trunc(maxMs));
  const delay = normalizedBase * 2 ** (normalizedAttempt - 1);
  return Math.min(normalizedMax, delay);
}
