import { resolveInitialLocale } from '@app/core/i18n/localeResolution';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, type Locale } from '@app/core/i18n/locales';
import { readPreference, storePreference } from '@app/core/preferenceStorage';
import { i18n, type Messages } from '@lingui/core';

interface Catalog {
  readonly messages: Messages;
}

const loadCatalog = (locale: Locale): Promise<Catalog> =>
  import(`@app/locales/${locale}/messages.po`);

const activateLocale = async (locale: Locale): Promise<void> => {
  const { messages } = await loadCatalog(locale);
  i18n.loadAndActivate({ locale, messages });
};

export const activateInitialLocale = async (): Promise<void> => {
  const locale = resolveInitialLocale({
    stored: readPreference(LOCALE_STORAGE_KEY),
    browserLanguages: navigator.languages,
  });
  try {
    await activateLocale(locale);
  } catch (error) {
    console.error(`could not load the "${locale}" messages; falling back to English`, error);
    await activateLocale(DEFAULT_LOCALE);
  }
};

export const changeLocale = async (locale: Locale): Promise<void> => {
  try {
    await activateLocale(locale);
    storePreference(LOCALE_STORAGE_KEY, locale);
  } catch (error) {
    console.error(`could not load the "${locale}" messages; keeping the current language`, error);
  }
};
