import { isSupportedLocale, toLanguageTag } from '@app/core/i18n/locales';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { I18nProvider as AriaI18nProvider } from 'react-aria-components';

const subscribeToLocale = (onChange: () => void): (() => void) => i18n.on('change', onChange);
const readActiveLocale = (): string => i18n.locale;

interface LocaleProviderProps {
  children: ReactNode;
}

export const LocaleProvider = ({ children }: LocaleProviderProps) => {
  const locale = useSyncExternalStore(subscribeToLocale, readActiveLocale);
  const languageTag = isSupportedLocale(locale) ? toLanguageTag(locale) : locale;

  useEffect(() => {
    document.documentElement.lang = languageTag;
  }, [languageTag]);

  return (
    <I18nProvider i18n={i18n}>
      <AriaI18nProvider locale={languageTag}>{children}</AriaI18nProvider>
    </I18nProvider>
  );
};
