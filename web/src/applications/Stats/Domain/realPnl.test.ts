import type { NetworthCurvePoint } from '@binsight/shared';
import { describe, expect, it } from 'vitest';
import { periodLabel, realPnlGain } from './realPnl';

/** An end-of-day curve point; `networth` is irrelevant to the gain, so it just mirrors the rest. */
const point = (date: string, realPnl: number, apports = 0): NetworthCurvePoint => ({
  date,
  realPnl,
  apports,
  networth: realPnl + apports,
});

// Sep 23 2026, 14:00 UTC — mid-day, so a rolling floor never sits on a day boundary.
const NOW = Date.UTC(2026, 8, 23, 14);

const SEPTEMBER = [
  point('2026-09-19', 1),
  point('2026-09-20', 2),
  point('2026-09-21', 3),
  point('2026-09-22', 4),
  point('2026-09-23', 5),
];

describe('realPnlGain', () => {
  it('measures 24H from the end of the day before the floor, not from today', () => {
    // floor = Sep 22 14:00 → baseline is the Sep 22 point (its day starts before the floor). The
    // first point ON/AFTER the floor is today's, which made 24H read ≈ 0.
    expect(realPnlGain(SEPTEMBER, '24h', NOW, 7)).toBe(7 - 4);
  });

  it('keeps the first day of a longer window', () => {
    const curve = [point('2026-09-15', 10), point('2026-09-16', 11), ...SEPTEMBER];
    // 7D floor = Sep 16 14:00 → the Sep 16 point is the last whose day starts before it.
    expect(realPnlGain(curve, '7d', NOW, 20)).toBe(20 - 11);
  });

  it('takes the YTD baseline from Dec 31, since Jan 1 starts exactly on the floor', () => {
    const now = Date.UTC(2026, 0, 3, 9);
    const curve = [point('2025-12-31', 8), point('2026-01-01', 9), point('2026-01-02', 12)];
    expect(realPnlGain(curve, 'ytd', now, 15)).toBe(15 - 8);
  });

  it('measures all-time from before the first day, when realPnl was 0', () => {
    expect(realPnlGain(SEPTEMBER, 'all', NOW, 7)).toBe(7);
  });

  it('falls back to the earliest point when the curve starts inside the window', () => {
    // A wallet younger than a month: nothing precedes the floor.
    expect(realPnlGain(SEPTEMBER, '1m', NOW, 7)).toBe(7 - 1);
  });

  it('prices "now" off the live net worth net of the LAST point apports', () => {
    const curve = [point('2026-09-22', 4, 10), point('2026-09-23', 5, 25)];
    // realPnlNow = 40 − 25 = 15; baseline = Sep 22's realPnl (4).
    expect(realPnlGain(curve, '24h', NOW, 40)).toBe(15 - 4);
  });

  it('can be negative', () => {
    expect(realPnlGain(SEPTEMBER, '24h', NOW, 1)).toBe(1 - 4);
  });

  it('is null without a curve or a live net worth', () => {
    expect(realPnlGain([], '24h', NOW, 7)).toBeNull();
    expect(realPnlGain(SEPTEMBER, '24h', NOW, null)).toBeNull();
  });
});

describe('periodLabel', () => {
  it('uses the filter bar label', () => {
    expect(periodLabel('24h')).toBe('24H');
    expect(periodLabel('ytd')).toBe('YTD');
    expect(periodLabel('all')).toBe('All');
  });
});
