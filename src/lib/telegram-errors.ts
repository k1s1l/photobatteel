export type TelegramErrorKind =
  | 'rate_limited' // 429 — retry after `retryAfterMs`
  | 'transient' // network problems / Telegram 5xx — retry with backoff
  | 'bot_blocked' // 403 from a private chat — the user blocked the bot
  | 'not_modified' // "message is not modified" — harmless
  | 'permanent'; // anything else (400/403/404): retrying will not help

export interface ClassifiedTelegramError {
  kind: TelegramErrorKind;
  description: string;
  retryAfterMs?: number;
}

interface TelegramLikeError {
  code?: unknown;
  description?: unknown;
  message?: unknown;
  parameters?: { retry_after?: unknown };
  response?: { error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Classifies errors thrown by Telegraf (TelegramError) or by the network layer. */
export function classifyTelegramError(error: unknown): ClassifiedTelegramError {
  const err = (error ?? {}) as TelegramLikeError & { errno?: unknown; type?: unknown; cause?: { code?: unknown } };
  const status = typeof err.response?.error_code === 'number' ? err.response.error_code : typeof err.code === 'number' ? err.code : undefined;
  const description = String(err.response?.description ?? err.description ?? err.message ?? 'Unknown error');

  if (status === 429) {
    const retryAfter = Number(err.response?.parameters?.retry_after ?? err.parameters?.retry_after ?? 5);
    return { kind: 'rate_limited', description, retryAfterMs: Math.max(1, retryAfter) * 1000 };
  }
  if (status !== undefined && status >= 500) return { kind: 'transient', description };
  if (status === 400 && /message is not modified/i.test(description)) return { kind: 'not_modified', description };
  if (status === 403 && /bot was blocked|user is deactivated|bot can't initiate/i.test(description)) {
    return { kind: 'bot_blocked', description };
  }
  if (status !== undefined) return { kind: 'permanent', description };

  const networkCode = typeof err.code === 'string' ? err.code : typeof err.cause?.code === 'string' ? err.cause.code : undefined;
  if ((networkCode && TRANSIENT_NETWORK_CODES.has(networkCode)) || err.type === 'system' || err.type === 'request-timeout') {
    return { kind: 'transient', description };
  }
  if (/timeout|socket hang up|network|fetch failed/i.test(description)) return { kind: 'transient', description };
  // Unknown non-Telegram errors (e.g. DB hiccups) are retried as well.
  return { kind: 'transient', description };
}

export function isRetryable(classified: ClassifiedTelegramError): boolean {
  return classified.kind === 'rate_limited' || classified.kind === 'transient';
}
