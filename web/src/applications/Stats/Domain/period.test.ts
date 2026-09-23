import { describe, expect, it } from 'vitest';
import { ALL_TIME_DAYS, PERIOD_OPTIONS, periodDays, sinceMs } from './period';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 23, 14);

describe('sinceMs', () => {
  it('looks back a fixed window for the rolling periods', () => {
    expect(sinceMs('24h', NOW)).toBe(NOW - DAY);
    expect(sinceMs('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(sinceMs('1m', NOW)).toBe(NOW - 30 * DAY);
    expect(sinceMs('3m', NOW)).toBe(NOW - 90 * DAY);
    expect(sinceMs('1y', NOW)).toBe(NOW - 365 * DAY);
  });

  it('floors YTD at Jan 1 UTC, whatever the local zone', () => {
    expect(sinceMs('ytd', NOW)).toBe(Date.UTC(2026, 0, 1));
    // The first hours of the year in UTC are still Dec 31 west of UTC — the floor must not care.
    expect(sinceMs('ytd', Date.UTC(2026, 0, 1, 3))).toBe(Date.UTC(2026, 0, 1));
  });

  it('is 0 (no floor) for all-time', () => {
    expect(sinceMs('all', NOW)).toBe(0);
  });
});

describe('periodDays', () => {
  it('maps the rolling periods to their length', () => {
    expect(periodDays('24h', NOW)).toBe(1);
    expect(periodDays('7d', NOW)).toBe(7);
    expect(periodDays('1m', NOW)).toBe(30);
    expect(periodDays('3m', NOW)).toBe(90);
    expect(periodDays('1y', NOW)).toBe(365);
  });

  it('covers YTD up to today, never less than one day', () => {
    // Jan 1 → Sep 23 14:00 is 265 days and a fraction; the partial day counts.
    expect(periodDays('ytd', NOW)).toBe(266);
    expect(periodDays('ytd', Date.UTC(2026, 0, 1))).toBe(1);
  });

  it('caps all-time to the shared maximum', () => {
    expect(periodDays('all', NOW)).toBe(ALL_TIME_DAYS);
  });
});

describe('PERIOD_OPTIONS', () => {
  it('offers every period once', () => {
    const values = PERIOD_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(['24h', '7d', '1m', '3m', '1y', 'ytd', 'all']);
  });
});
