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
});
