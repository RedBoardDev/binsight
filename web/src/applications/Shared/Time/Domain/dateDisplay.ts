import { dateTimeFormat } from '@app/applications/Shared/Time/Domain/timeFormat';

// Days are those of the instance's time zone, not the browser's.
export type DateDisplay = 'time' | 'day-and-time' | 'date';

export const DATE_DISPLAY_OPTIONS: Record<DateDisplay, Intl.DateTimeFormatOptions> = {
  time: { hour: '2-digit', minute: '2-digit' },
  'day-and-time': {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
  date: { year: 'numeric', month: 'short', day: 'numeric' },
};

const calendarDay = (at: Date, timeZone: string): string =>
  dateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    at,
  );

export const dateDisplayFor = (at: Date, now: Date, timeZone: string): DateDisplay => {
  const day = calendarDay(at, timeZone);
  const today = calendarDay(now, timeZone);
  if (day === today) {
    return 'time';
  }
  return day.slice(0, 4) === today.slice(0, 4) ? 'day-and-time' : 'date';
};
