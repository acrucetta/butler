export interface TypingIndicatorOptions {
  enabled: boolean;
  intervalMs: number;
  tick: () => Promise<void> | void;
}

export interface TypingIndicatorHandle {
  stop: () => void;
}

export function startTypingIndicator(options: TypingIndicatorOptions): TypingIndicatorHandle {
  if (!options.enabled) {
    return { stop: () => undefined };
  }

  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs));
  let stopped = false;

  const runTick = () => {
    if (stopped) {
      return;
    }
    void Promise.resolve(options.tick()).catch(() => undefined);
  };

  runTick();
  const timer = setInterval(runTick, intervalMs);

  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    }
  };
}
