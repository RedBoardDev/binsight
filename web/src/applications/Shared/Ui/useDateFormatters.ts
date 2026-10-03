import { isSupportedLocale, toLanguageTag } from '@app/core/i18n/locales';
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';

const EMPTY_VALUE = '—';

interface DateFormatters {
  readonly formatTime: (timestamp: string | null) => string;
  readonly formatDateTime: (timestamp: string | null) => string;
}

const formatWith =
  (format: Intl.DateTimeFormat) =>
  (timestamp: string | null): string => {
    if (timestamp === null) {
      return EMPTY_VALUE;
    }
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? EMPTY_VALUE : format.format(date);
  };

// Formats API timestamps (RFC 3339, UTC) in the browser's time zone and the active language.
export const useDateFormatters = (): DateFormatters => {
  const { i18n } = useLingui();
  const locale = isSupportedLocale(i18n.locale) ? toLanguageTag(i18n.locale) : i18n.locale;

  return useMemo(
    () => ({
      formatTime: formatWith(new Intl.DateTimeFormat(locale, { timeStyle: 'medium' })),
      formatDateTime: formatWith(
        new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
      ),
    }),
    [locale],
  );
};
