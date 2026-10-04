import { readableDuration } from '@app/applications/Shared/Time/Domain/readableDuration';
import { describe, expect, it } from 'vitest';

const parts = (seconds: number) => {
  const duration = readableDuration(seconds);
  return duration.kind === 'parts' ? duration.parts : duration.kind;
};

describe('readableDuration', () => {
  it('says "under a minute" below sixty seconds', () => {
    expect(parts(0)).toBe('under-a-minute');
    expect(parts(59)).toBe('under-a-minute');
  });

  it('counts minutes, then hours and minutes', () => {
    expect(parts(42 * 60 + 30)).toEqual({ minutes: 42 });
    expect(parts(2 * 3_600 + 14 * 60)).toEqual({ hours: 2, minutes: 14 });
    expect(parts(5 * 3_600)).toEqual({ hours: 5 });
  });

  it('counts days and hours, then days alone from three days', () => {
    expect(parts(86_400 + 3_600 + 59)).toEqual({ days: 1, hours: 1 });
    expect(parts(2 * 86_400)).toEqual({ days: 2 });
    expect(parts(4 * 86_400 + 5 * 3_600)).toEqual({ days: 4 });
  });
});
