import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { getLocale } from '../../src/i18n/index.js';
import { maskSecrets } from '../../src/lib/logger.js';
import { buildChannelCaption, buildVoteKeyboard } from '../../src/modules/publications/channel-post.js';

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

describe('secrets masking', () => {
  it('masks bot tokens inside URLs and messages', () => {
    const text = 'GET https://api.telegram.org/file/bot123456789:AAFakeTokenForTestingPurposesOnly_1234/photos/1.jpg failed';
    expect(maskSecrets(text)).not.toContain('AAFake');
    expect(maskSecrets(text)).toContain('<bot-token>');
  });
});

describe('channel post', () => {
  const locale = getLocale('ru');

  it('renders the required caption format and escapes user names', () => {
    const caption = buildChannelCaption(locale, { id: 1 }, { username: null, firstName: '<Kate>', lastName: null }, null);
    expect(caption).toContain('📸 <b>PHOTO BATTLE</b>');
    expect(caption).toContain('Участник: &lt;Kate&gt;');
    expect(caption).toContain('ID фотографии: #0001');
    expect(caption).toContain('🔥 Поддержи участника!');
    expect(buildChannelCaption(locale, { id: 2 }, { username: 'kate', firstName: 'K', lastName: null }, 'Осень')).toContain('Участник: @kate');
  });

  it('shows vote count on the button', () => {
    expect(buildVoteKeyboard(locale, 5, 0).inline_keyboard[0]?.[0]).toMatchObject({ text: '🔥 Поддержать', callback_data: 'v:5' });
    expect(buildVoteKeyboard(locale, 5, 3).inline_keyboard[0]?.[0]?.text).toBe('🔥 Поддержать · 3');
  });
});
