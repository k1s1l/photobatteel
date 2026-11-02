import { ru, type Locale } from './locales/ru.js';

export type { Locale };

/**
 * Registered locales. To add Ukrainian: create `locales/uk.ts` exporting
 * `export const uk: Locale = { ... }` and register it here as `uk`.
 */
const locales = { ru } satisfies Record<string, Locale>;

export type LanguageCode = keyof typeof locales;

export const DEFAULT_LANGUAGE: LanguageCode = 'ru';

export function isSupportedLanguage(code: string | undefined | null): code is LanguageCode {
  return !!code && Object.hasOwn(locales, code);
}

export function getLocale(code?: string | null): Locale {
  return isSupportedLanguage(code) ? locales[code] : locales[DEFAULT_LANGUAGE];
}

/** All translations of a phrase — used to match reply-keyboard buttons in any language. */
export function allTranslations(select: (locale: Locale) => string): string[] {
  return [...new Set(Object.values(locales).map(select))];
}
