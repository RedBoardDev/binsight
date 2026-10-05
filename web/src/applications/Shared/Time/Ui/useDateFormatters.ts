import {
  DATE_DISPLAY_OPTIONS,
  dateDisplayFor,
} from '@app/applications/Shared/Time/Domain/dateDisplay';
import { useInstanceTimeZone } from '@app/applications/Shared/Time/Ui/useInstanceTimeZone';
import { useLanguageTag } from '@app/core/i18n/useLanguageTag';
import { useMemo } from 'react';

const EMPTY_VALUE = '—';

interface DateFormatters {
  readonly formatTime: (timestamp: string | null) => string;
  readonly formatDateTime: (timestamp: string | null) => string;
  readonly formatShortDate: (timestamp: string | null) => string;
  readonly formatMoment: (timestamp: string | null, now: number) => string;
}

const parseTimestamp = (timestamp: string | null): Date | null => {
  if (timestamp === null) {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatWith =
  (format: Intl.DateTimeFormat) =>
  (timestamp: string | null): string => {
    const date = parseTimestamp(timestamp);
    return date === null ? EMPTY_VALUE : format.format(date);
  };

// Formats API timestamps (RFC 3339, UTC) in the instance's time zone and the active language.
export const useDateFormatters = (): DateFormatters => {
  const locale = useLanguageTag();
  const timeZone = useInstanceTimeZone();

  return useMemo(() => {
    const moments = {
      time: new Intl.DateTimeFormat(locale, { ...DATE_DISPLAY_OPTIONS.time, timeZone }),
      'day-and-time': new Intl.DateTimeFormat(locale, {
        ...DATE_DISPLAY_OPTIONS['day-and-time'],
        timeZone,
      }),
      date: new Intl.DateTimeFormat(locale, { ...DATE_DISPLAY_OPTIONS.date, timeZone }),
    };
    return {
      formatShortDate: formatWith(
        new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }),
      ),
      formatTime: formatWith(new Intl.DateTimeFormat(locale, { timeStyle: 'medium', timeZone })),
      formatDateTime: formatWith(
        new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium', timeZone }),
      ),
      formatMoment: (timestamp, now) => {
        const date = parseTimestamp(timestamp);
        return date === null
          ? EMPTY_VALUE
          : moments[dateDisplayFor(date, new Date(now), timeZone)].format(date);
      },
    };
  }, [locale, timeZone]);
};
