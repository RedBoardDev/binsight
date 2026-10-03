import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '@app/core/i18n/locales';

interface LocaleSources {
  readonly stored: string | null;
  readonly browserLanguages: readonly string[];
}

const primaryLanguageOf = (languageTag: string): string =>
  languageTag.split('-')[0]?.toLowerCase() ?? '';

export const resolveInitialLocale = ({ stored, browserLanguages }: LocaleSources): Locale => {
  if (isSupportedLocale(stored)) {
    return stored;
  }
  const browserLocale = browserLanguages.map(primaryLanguageOf).find(isSupportedLocale);
  return browserLocale ?? DEFAULT_LOCALE;
};
