import { describe, expect, it } from 'vitest';
import {
  fmtDate,
  fmtDateFull,
  fmtDay,
  fmtDayFull,
  fmtDuration,
  fmtRelative,
  fmtSol,
  fmtSolSigned,
  shortAddr,
} from './formatters';

// The suite runs in America/Los_Angeles (vitest.config.ts): west of UTC, where a UTC midnight is
// still the previous evening locally.
const MARCH_4_UTC = Date.UTC(2026, 2, 4);

describe('day buckets', () => {
  it('names the UTC day a bucket stands for', () => {
    expect(fmtDay(MARCH_4_UTC)).toBe('Mar 4');
    expect(fmtDayFull(MARCH_4_UTC)).toBe('Mar 4, 2026');
  });

  it('would land a day early through the local-time formatters', () => {
    // The bug this guards: the same bucket through the instant formatters reads Mar 3 here.
    expect(fmtDate(MARCH_4_UTC)).toBe('Mar 3');
    expect(fmtDateFull(MARCH_4_UTC)).toBe('Mar 3, 2026');
  });

  it('keeps the year boundary on the right side', () => {
    expect(fmtDayFull(Date.UTC(2026, 0, 1))).toBe('Jan 1, 2026');
  });
});

describe('instants', () => {
  it('stay in local time', () => {
    // 20:00 UTC on Mar 4 is noon on Mar 4 in Los Angeles.
    expect(fmtDate(Date.UTC(2026, 2, 4, 20))).toBe('Mar 4');
  });

  it('render a dash when unknown', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDateFull(null)).toBe('—');
  });
});

describe('fmtSol', () => {
  it('shows milli-SOL precision, signed on demand', () => {
    expect(fmtSol(1.23456)).toBe('1.235');
    expect(fmtSolSigned(0.5)).toBe('+0.500');
    expect(fmtSolSigned(-0.5)).toBe('-0.500');
    expect(fmtSolSigned(0)).toBe('0.000');
  });
});

describe('fmtDuration', () => {
  it('keeps the two most significant units', () => {
    expect(fmtDuration(2 * 86_400 + 4 * 3_600 + 59)).toBe('2d 4h');
    expect(fmtDuration(3 * 3_600 + 12 * 60)).toBe('3h 12m');
    expect(fmtDuration(45 * 60)).toBe('45m');
    expect(fmtDuration(12)).toBe('12s');
  });

  it('renders a dash for an unknown or negative duration', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(-1)).toBe('—');
  });
});

describe('fmtRelative', () => {
  const now = Date.UTC(2026, 8, 23, 12);

  it('reads as elapsed time', () => {
    expect(fmtRelative(now - 10_000, now)).toBe('just now');
    expect(fmtRelative(now - 5 * 60_000, now)).toBe('5m ago');
    expect(fmtRelative(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(fmtRelative(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(fmtRelative(null, now)).toBe('—');
  });
});

describe('shortAddr', () => {
  it('keeps the head and tail of a long address', () => {
    expect(shortAddr('HXUi1234567890abcdefE5a6y')).toBe('HXUi…5a6y');
    expect(shortAddr('abcdefghij', 2, 2)).toBe('ab…ij');
  });

  it('leaves a short string alone', () => {
    expect(shortAddr('abc')).toBe('abc');
  });
});
