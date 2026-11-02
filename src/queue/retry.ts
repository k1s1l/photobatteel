/** Thrown by job processors to request a retry; carries Telegram's retry_after when known. */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Backoff for Telegram operations: honours retry_after from 429 responses,
 * otherwise exponential (base, 2×base, 4×base…) capped at 30 minutes.
 */
export function telegramBackoff(baseMs: number) {
  return (attemptsMade: number, _type?: string, err?: Error): number => {
    if (err instanceof RetryLaterError && err.retryAfterMs) return err.retryAfterMs + 500;
    const retryAfter = (err as { parameters?: { retry_after?: number } } | undefined)?.parameters?.retry_after;
    if (typeof retryAfter === 'number') return retryAfter * 1000 + 500;
    return Math.min(baseMs * 2 ** Math.max(0, attemptsMade - 1), MAX_BACKOFF_MS);
  };
}
