/**
 * Utility for limiting conversation history to the most recent N user turns.
 *
 * When the embedded SDK resumes a session it loads the full history.  For very
 * long-running conversations this can bloat context.  `limitHistoryTurns`
 * trims the front while keeping the trailing turns intact.
 */

/** Minimal shape needed — works with any message that has a `role` string. */
export interface HistoryMessage {
  role: string;
}

const DEFAULT_TURN_LIMIT = 30;

/**
 * Keep only the last `limit` user turns (and everything that follows the
 * first kept user turn).  A "turn" is counted each time a message with
 * `role === "user"` is encountered while scanning backward.
 *
 * Special cases:
 * - `limit` is `undefined`, `0`, or negative → return all messages unchanged.
 * - `messages` is empty → return empty array.
 */
export function limitHistoryTurns<T extends HistoryMessage>(
  messages: T[],
  limit: number | undefined = DEFAULT_TURN_LIMIT
): T[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  // Walk backward and find the index of the Nth user turn from the end.
  // We keep everything from that user message onward.
  let userTurnsSeen = 0;
  let keepFromIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen === limit) {
        keepFromIndex = i;
        break;
      }
    }
  }

  return messages.slice(keepFromIndex);
}
