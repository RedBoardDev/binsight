import { relativeTime } from '@app/applications/Shared/Time/Domain/relativeTime';
import { describe, expect, it } from 'vitest';

describe('relativeTime', () => {
  it('says "just now" under a minute, even for a clock slightly ahead', () => {
    expect(relativeTime(59)).toEqual({ kind: 'just-now' });
    expect(relativeTime(-5)).toEqual({ kind: 'just-now' });
  });

  it('uses the largest unit that fits', () => {
    expect(relativeTime(3 * 60 + 20)).toEqual({ kind: 'ago', value: 3, unit: 'minute' });
    expect(relativeTime(5 * 3_600 + 59 * 60)).toEqual({ kind: 'ago', value: 5, unit: 'hour' });
    expect(relativeTime(2 * 86_400 + 1)).toEqual({ kind: 'ago', value: 2, unit: 'day' });
  });
});
