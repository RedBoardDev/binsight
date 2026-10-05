import { nearestPoint } from '@app/applications/Shared/Chart/Domain/nearestPoint';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

describe('nearestPoint', () => {
  it('clamps the readout to the first or last sample', () => {
    expect(nearestPoint([10, 20, 35], -10)).toBe(0);
    expect(nearestPoint([10, 20, 35], 100)).toBe(2);
    expect(nearestPoint([10], 100)).toBe(0);
  });

  it('chooses the earlier sample on an equal distance and exact duplicates', () => {
    expect(nearestPoint([10, 20, 35], 15)).toBe(0);
    expect(nearestPoint([10, 20, 20, 35], 20)).toBe(1);
    expect(nearestPoint([10, 20, 35], 33)).toBe(2);
  });

  it('returns no sample for an empty series or nonfinite pointer', () => {
    expect(nearestPoint([], 10)).toBeNull();
    expect(nearestPoint([10], NaN)).toBeNull();
  });

  it('finds a globally closest sample in a sorted series', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -10000, max: 10000 }), { minLength: 1, maxLength: 100 }),
        fc.integer({ min: -20000, max: 20000 }),
        (samples, target) => {
          const positions = [...samples].sort((left, right) => left - right);
          const index = nearestPoint(positions, target);
          const selected = index === null ? undefined : positions[index];
          expect(selected).toBeDefined();
          if (selected === undefined) return;
          expect(Math.abs(selected - target)).toBe(
            Math.min(...positions.map((value) => Math.abs(value - target))),
          );
        },
      ),
    );
  });
});
