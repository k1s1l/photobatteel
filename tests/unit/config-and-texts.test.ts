import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { maskSecrets } from '../../src/lib/logger.js';

const base = {
  BOT_TOKEN: '123456789:AAFakeTokenForTestingPurposesOnly_1234',
  CHANNEL_ID: '-1001234567890',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
};

describe('environment validation', () => {
  it('parses a minimal valid configuration with defaults', () => {
    const env = parseEnv({ ...base, ADMIN_IDS: '1, 2;3' });
    expect(env.ADMIN_IDS).toEqual([1, 2, 3]);
    expect(env.BOT_MODE).toBe('polling');
    expect(env.PUBLISH_MAX_ATTEMPTS).toBe(5);
  });

  it('rejects invalid values without leaking them', () => {
    expect(() => parseEnv({ ...base, BOT_TOKEN: 'secret-value', ADMIN_IDS: 'abc' })).toThrow(/BOT_TOKEN/);
    try {
      parseEnv({ ...base, BOT_TOKEN: 'secret-value' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-value');
    }
  });

  it('requires webhook settings in webhook mode', () => {
    expect(() => parseEnv({ ...base, BOT_MODE: 'webhook' })).toThrow(/WEBHOOK_DOMAIN/);
  });
});

describe('optional integrations', () => {
  it('ignores empty or invalid payment tokens instead of crashing', () => {
    const env = parseEnv({ ...base, PAYMENT_PROVIDER_TOKEN: '123', MONOBANK_TOKEN: '' });
    expect(env.PAYMENT_PROVIDER_TOKEN).toBeUndefined();
    expect(env.MONOBANK_TOKEN).toBeUndefined();
  });

  it('keeps valid payment tokens', () => {
    const env = parseEnv({ ...base, PAYMENT_PROVIDER_TOKEN: '1234567890:TEST:abc' });
    expect(env.PAYMENT_PROVIDER_TOKEN).toBe('1234567890:TEST:abc');
  });
});

describe('secrets masking', () => {
  it('masks bot tokens inside URLs and messages', () => {
    const text = 'GET https://api.telegram.org/file/bot123456789:AAFakeTokenForTestingPurposesOnly_1234/photos/1.jpg failed';
    expect(maskSecrets(text)).not.toContain('AAFake');
    expect(maskSecrets(text)).toContain('<bot-token>');
  });
});
