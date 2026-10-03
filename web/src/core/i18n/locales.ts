export const SUPPORTED_LOCALES = ['en', 'fr', 'de'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_STORAGE_KEY = 'binsight.locale';

// Each language is named in itself, so a reader finds their own language whatever is active.
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
};

const LANGUAGE_TAGS: Record<Locale, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  de: 'de-DE',
};

export const isSupportedLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);

export const toLanguageTag = (locale: Locale): string => LANGUAGE_TAGS[locale];
