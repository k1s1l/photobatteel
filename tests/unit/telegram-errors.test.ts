import { describe, expect, it } from 'vitest';
import { classifyTelegramError, isRetryable } from '../../src/lib/telegram-errors.js';
import { RetryLaterError, telegramBackoff } from '../../src/queue/retry.js';
import { telegramError } from '../helpers/fakes.js';

describe('Telegram error classification', () => {
  it('treats 429 as rate limit with retry_after', () => {
    const result = classifyTelegramError(telegramError(429, 'Too Many Requests: retry after 7', 7));
    expect(result).toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    expect(isRetryable(result)).toBe(true);
  });

  it('retries server and network errors', () => {
    expect(classifyTelegramError(telegramError(502, 'Bad Gateway')).kind).toBe('transient');
    expect(classifyTelegramError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).kind).toBe('transient');
  });

  it('does not retry permanent errors', () => {
    const chatNotFound = classifyTelegramError(telegramError(400, 'Bad Request: chat not found'));
    expect(chatNotFound.kind).toBe('permanent');
    expect(isRetryable(chatNotFound)).toBe(false);
    expect(classifyTelegramError(telegramError(403, 'Forbidden: bot is not a member of the channel chat')).kind).toBe('permanent');
  });

  it('recognises blocked bots and not-modified edits', () => {
    expect(classifyTelegramError(telegramError(403, 'Forbidden: bot was blocked by the user')).kind).toBe('bot_blocked');
    expect(classifyTelegramError(telegramError(400, 'Bad Request: message is not modified')).kind).toBe('not_modified');
  });
});

describe('retry backoff', () => {
  const backoff = telegramBackoff(1000);

  it('grows exponentially and is capped', () => {
    expect(backoff(1)).toBe(1000);
    expect(backoff(2)).toBe(2000);
    expect(backoff(4)).toBe(8000);
    expect(backoff(30)).toBe(30 * 60_000);
  });

  it("honours Telegram's retry_after", () => {
    expect(backoff(1, 'telegram', new RetryLaterError('429', 12_000))).toBe(12_500);
  });
});
