import { reconnectDelay } from '@app/applications/Realtime/Domain/reconnectDelay';
import { describe, expect, it } from 'vitest';

describe('reconnectDelay', () => {
  it('doubles from one second and stops at thirty', () => {
    const highest = (): number => 1;

    expect([0, 1, 2, 3, 4, 5, 9].map((attempt) => reconnectDelay(attempt, highest))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('waits between half and all of the back-off', () => {
    expect(reconnectDelay(3, () => 0)).toBe(4_000);
    expect(reconnectDelay(3, () => 0.5)).toBe(6_000);
  });
});
