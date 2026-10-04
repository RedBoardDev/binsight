import { isSupportedLocale, toLanguageTag } from '@app/core/i18n/locales';
import { useLingui } from '@lingui/react/macro';

export const useLanguageTag = (): string => {
  const { i18n } = useLingui();
  return isSupportedLocale(i18n.locale) ? toLanguageTag(i18n.locale) : i18n.locale;
};
