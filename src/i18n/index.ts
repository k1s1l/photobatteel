import { ru, type Locale } from './locales/ru.js';
import { uk } from './locales/uk.js';

export type { Locale };

/** Registered locales. A new language = a new file typed as `Locale` + an entry here. */
const locales = { uk, ru } satisfies Record<string, Locale>;

export type LanguageCode = keyof typeof locales;

export const SUPPORTED_LANGUAGES = Object.keys(locales) as LanguageCode[];

let defaultLanguage: LanguageCode = 'uk';

/** Set once at startup from DEFAULT_LANGUAGE. */
export function setDefaultLanguage(code: LanguageCode): void {
  defaultLanguage = code;
}

export function getDefaultLanguage(): LanguageCode {
  return defaultLanguage;
}

export function isSupportedLanguage(code: string | undefined | null): code is LanguageCode {
  return !!code && Object.hasOwn(locales, code);
}

/** Resolves a Telegram language code ("uk", "ru", "en"…) to a locale; unknown codes get the default. */
export function getLocale(code?: string | null): Locale {
  const normalized = code?.toLowerCase().split('-')[0];
  return isSupportedLanguage(normalized) ? locales[normalized] : locales[defaultLanguage];
}

/** All translations of a phrase — used to match reply-keyboard buttons in any language. */
export function allTranslations(select: (locale: Locale) => string): string[] {
  return [...new Set(Object.values(locales).map(select))];
}
