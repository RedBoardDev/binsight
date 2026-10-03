import { resolveInitialLocale } from '@app/core/i18n/localeResolution';
import { readStoredLocale, storeLocale } from '@app/core/i18n/localeStorage';
import { DEFAULT_LOCALE, type Locale } from '@app/core/i18n/locales';
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
    stored: readStoredLocale(),
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
    storeLocale(locale);
  } catch (error) {
    console.error(`could not load the "${locale}" messages; keeping the current language`, error);
  }
};
