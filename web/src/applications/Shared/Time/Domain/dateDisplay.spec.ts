import { dateDisplayFor } from '@app/applications/Shared/Time/Domain/dateDisplay';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-10-04T10:00:00Z');

describe('dateDisplayFor', () => {
  it('writes only the time for today', () => {
    expect(dateDisplayFor(new Date('2026-10-04T08:15:00Z'), NOW, 'UTC')).toBe('time');
  });

  it('adds the day for an earlier day of this year', () => {
    expect(dateDisplayFor(new Date('2026-10-03T21:00:00Z'), NOW, 'UTC')).toBe('day-and-time');
  });

  it('writes the date for an earlier year', () => {
    expect(dateDisplayFor(new Date('2025-10-03T21:00:00Z'), NOW, 'UTC')).toBe('date');
  });

  it('counts days in the time zone of the instance', () => {
    const lateEveningInParis = new Date('2026-10-03T22:30:00Z');
    expect(dateDisplayFor(lateEveningInParis, NOW, 'Europe/Paris')).toBe('time');
    expect(dateDisplayFor(lateEveningInParis, NOW, 'UTC')).toBe('day-and-time');
  });
});
