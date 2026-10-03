import { LOCALE_STORAGE_KEY, type Locale } from '@app/core/i18n/locales';

// Storage can throw (blocked cookies, some private modes). Losing the saved preference is
// acceptable; crashing the app over it is not.

export const readStoredLocale = (): string | null => {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
};

export const storeLocale = (locale: Locale): void => {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch (error) {
    console.warn('the language preference could not be saved', error);
  }
};
