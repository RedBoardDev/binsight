import { niceTicks } from '@app/applications/Shared/Chart/Domain/niceTicks';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

describe('niceTicks', () => {
  it('extends both bounds to simple graduations and includes exact zero', () => {
    expect(niceTicks({ minimum: -3, maximum: 8 })).toEqual({
      domain: { minimum: -5, maximum: 10 },
      positions: [-5, 0, 5, 10],
    });
    expect(niceTicks({ minimum: 0, maximum: 10 })).toEqual({
      domain: { minimum: 0, maximum: 10 },
      positions: [0, 2.5, 5, 7.5, 10],
    });
  });

  it('covers each nonconstant domain with ordered finite ticks', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: -9, max: 9 }),
        (start, span, exponent) => {
          const minimum = start * 10 ** exponent;
          const maximum = (start + span) * 10 ** exponent;
          const ticks = niceTicks({ minimum, maximum });
          const tolerance = span * 10 ** exponent * 1e-12;
          expect(ticks.domain.minimum).toBeLessThanOrEqual(minimum + tolerance);
          expect(ticks.domain.maximum).toBeGreaterThanOrEqual(maximum - tolerance);
          expect(ticks.positions.length).toBeLessThanOrEqual(7);
          expect(
            ticks.positions.every(
              (value, index) =>
                Number.isFinite(value) &&
                (index === 0 || value > (ticks.positions[index - 1] ?? value)),
            ),
          ).toBe(true);
          if (minimum <= 0 && maximum >= 0) expect(ticks.positions).toContain(0);
        },
      ),
    );
  });

  it('keeps a constant domain as one tick without inventing a monetary span', () => {
    expect(niceTicks({ minimum: 0, maximum: 0 }).positions).toEqual([0]);
    expect(niceTicks({ minimum: 42, maximum: 42 }).positions).toEqual([42]);
  });

  it('rejects invalid counts and unrepresentable subnormal tick spacing', () => {
    expect(() => niceTicks({ minimum: 0, maximum: 1 }, 1)).toThrow(RangeError);
    expect(() => niceTicks({ minimum: 0, maximum: 1 }, 101)).toThrow(RangeError);
    expect(() => niceTicks({ minimum: 0, maximum: Number.MIN_VALUE })).toThrow(RangeError);
  });
});
