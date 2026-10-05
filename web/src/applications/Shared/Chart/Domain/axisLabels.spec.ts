import { axisLabels } from '@app/applications/Shared/Chart/Domain/axisLabels';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

describe('axisLabels', () => {
  it('keeps at most five evenly spaced sample indices with both endpoints', () => {
    expect(axisLabels(101)).toEqual([0, 25, 50, 75, 100]);
    expect(axisLabels(8, 3)).toEqual([0, 4, 7]);
  });

  it('handles empty, singleton and short series without repeated labels', () => {
    expect(axisLabels(0)).toEqual([]);
    expect(axisLabels(1)).toEqual([0]);
    expect(axisLabels(3)).toEqual([0, 1, 2]);
  });

  it('retains ordered indices inside every nonempty series', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10000 }), (count) => {
        const labels = axisLabels(count);
        expect(labels[0]).toBe(0);
        expect(labels.at(-1)).toBe(count - 1);
        expect(labels.length).toBeLessThanOrEqual(5);
        expect(new Set(labels).size).toBe(labels.length);
      }),
    );
  });

  it('rejects fractional counts and a label budget outside two through five', () => {
    expect(() => axisLabels(1.5)).toThrow(RangeError);
    expect(() => axisLabels(20, 6)).toThrow(RangeError);
    expect(() => axisLabels(20, 1)).toThrow(RangeError);
  });

  it('spaces irregular drawing positions and suppresses neighboring labels without dropping readings', () => {
    expect(axisLabels(3, 3, { positions: [24, 24, 25], minimumSpacing: 64 })).toEqual([0]);
    expect(
      axisLabels(8, 5, { positions: [24, 30, 36, 100, 106, 112, 200, 206], minimumSpacing: 64 }),
    ).toEqual([0, 5, 7]);
    expect(axisLabels(0, 3, { positions: [], minimumSpacing: 64 })).toEqual([]);
    for (const spacing of [
      { positions: [0], minimumSpacing: 0 },
      { positions: [0, 1], minimumSpacing: 64 },
      { positions: [Number.NaN], minimumSpacing: 64 },
    ])
      expect(() => axisLabels(1, 3, spacing)).toThrow(RangeError);
    expect(() => axisLabels(2, 3, { positions: [10, 0], minimumSpacing: 64 })).toThrow(RangeError);
  });

  it('retains ordered distinct indices with the required distance for arbitrary clustered positions', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 100 }), (samples) => {
        const positions = [...samples].sort((left, right) => left - right);
        const labels = axisLabels(positions.length, 5, { positions, minimumSpacing: 64 });
        expect(labels.length).toBeLessThanOrEqual(5);
        expect(new Set(labels).size).toBe(labels.length);
        for (let index = 1; index < labels.length; index += 1) {
          const current = labels[index];
          const previous = labels[index - 1];
          if (current === undefined || previous === undefined)
            throw new Error('A label index is missing');
          expect(current).toBeGreaterThan(previous);
          expect((positions[current] ?? 0) - (positions[previous] ?? 0)).toBeGreaterThanOrEqual(64);
        }
      }),
      { numRuns: 500 },
    );
  });
});
