import { describe, expect, it } from 'vitest';
import { allTranslations, getLocale, setDefaultLanguage } from '../../src/i18n/index.js';
import { ru } from '../../src/i18n/locales/ru.js';
import { uk } from '../../src/i18n/locales/uk.js';
import { formatCardPrice } from '../../src/modules/payments/payment.service.js';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe('localization', () => {
  it('Ukrainian has exactly the same keys as Russian', () => {
    expect(keyPaths(uk).sort()).toEqual(keyPaths(ru).sort());
  });

  it('resolves Telegram language codes with a configurable default', () => {
    setDefaultLanguage('uk');
    expect(getLocale('uk').languageName).toBe('Українська');
    expect(getLocale('ru').languageName).toBe('Русский');
    expect(getLocale('en').languageName).toBe('Українська');
    expect(getLocale('').languageName).toBe('Українська');
    setDefaultLanguage('ru');
    expect(getLocale('de').languageName).toBe('Русский');
  });

  it('matches menu buttons in both languages', () => {
    expect(allTranslations((l) => l.menu.submit)).toEqual(['📸 Надіслати фото або відео', '📸 Отправить фото или видео']);
  });

  it('formats card prices', () => {
    expect(formatCardPrice(8900, 'UAH')).toBe('89 ₴');
    expect(formatCardPrice(8950, 'UAH')).toBe('89.50 ₴');
    expect(formatCardPrice(500, 'EUR')).toBe('5 EUR');
  });
});
