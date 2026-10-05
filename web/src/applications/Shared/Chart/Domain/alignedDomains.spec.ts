import {
  alignedDomains,
  ZERO_LINE_MAX_RATIO,
  ZERO_LINE_MIN_RATIO,
} from '@app/applications/Shared/Chart/Domain/alignedDomains';
import { linearScale } from '@app/applications/Shared/Chart/Domain/linearScale';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

describe('alignedDomains', () => {
  it('shares a zero line while retaining both original extents', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.integer({ min: -10000, max: 0 }), fc.integer({ min: 0, max: 10000 })),
        fc.tuple(fc.integer({ min: -10000, max: 0 }), fc.integer({ min: 0, max: 10000 })),
        ([leftMinimum, leftMaximum], [rightMinimum, rightMaximum]) => {
          const original = [
            { minimum: leftMinimum, maximum: leftMaximum },
            { minimum: rightMinimum, maximum: rightMaximum },
          ] as const;
          const domains = alignedDomains(...original);
          const pixels = { minimum: 200, maximum: 0 };
          expect(linearScale(domains[0], pixels).project(0)).toBeCloseTo(
            linearScale(domains[1], pixels).project(0),
            10,
          );
          for (const [index, domain] of domains.entries()) {
            expect(domain.minimum).toBeLessThanOrEqual(original[index]?.minimum ?? 0);
            expect(domain.maximum).toBeGreaterThanOrEqual(original[index]?.maximum ?? 0);
            const fraction = -domain.minimum / (domain.maximum - domain.minimum);
            expect(fraction).toBeGreaterThanOrEqual(ZERO_LINE_MIN_RATIO - 1e-12);
            expect(fraction).toBeLessThanOrEqual(ZERO_LINE_MAX_RATIO + 1e-12);
          }
        },
      ),
    );
  });

  it('retains drawing room for zero and constant series', () => {
    const domains = alignedDomains({ minimum: 0, maximum: 0 }, { minimum: 5, maximum: 5 });
    for (const domain of domains) expect(domain.maximum).toBeGreaterThan(domain.minimum);
    expect(domains[1].maximum).toBeGreaterThan(5);
  });

  it('clamps positive and negative series to the planned zero ratios', () => {
    const ratio = (minimum: number, maximum: number) => {
      const [domain] = alignedDomains({ minimum, maximum }, { minimum, maximum });
      return -domain.minimum / (domain.maximum - domain.minimum);
    };
    expect(ratio(1, 10)).toBeCloseTo(0.001, 12);
    expect(ratio(-10, -1)).toBeCloseTo(0.85, 12);
    expect(ratio(0, 0)).toBeCloseTo(0.5, 12);
  });
});
