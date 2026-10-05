import { linearScale } from '@app/applications/Shared/Chart/Domain/linearScale';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

describe('linearScale', () => {
  it('projects the bounds and zero to their pixel positions', () => {
    const scale = linearScale({ minimum: -20, maximum: 80 }, { minimum: 100, maximum: 0 });
    expect(scale.project(-20)).toBe(100);
    expect(scale.project(80)).toBe(0);
    expect(scale.project(0)).toBe(80);
    expect(scale.invert(80)).toBe(0);
  });

  it('inverts a projection across increasing and reversed pixel ranges', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10000, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 0, max: 1000 }),
        (minimum, span, pixel) => {
          for (const maximumPixel of [1000, -1000]) {
            const scale = linearScale(
              { minimum, maximum: minimum + span },
              { minimum: 0, maximum: maximumPixel },
            );
            const value = minimum + (pixel / 1000) * span;
            expect(scale.invert(scale.project(value))).toBeCloseTo(value, 8);
          }
        },
      ),
    );
  });

  it('centers a constant series and keeps its inverse constant', () => {
    const scale = linearScale({ minimum: 7, maximum: 7 }, { minimum: 100, maximum: 0 });
    expect(scale.project(7)).toBe(50);
    expect(scale.invert(80)).toBe(7);
    expect(linearScale({ minimum: 0, maximum: 10 }, { minimum: 5, maximum: 5 }).invert(5)).toBe(0);
  });

  it('rejects reversed domains and nonfinite bounds or spans', () => {
    expect(() => linearScale({ minimum: 1, maximum: 0 }, { minimum: 0, maximum: 10 })).toThrow(
      RangeError,
    );
    expect(() =>
      linearScale({ minimum: 0, maximum: Infinity }, { minimum: 0, maximum: 10 }),
    ).toThrow(RangeError);
    expect(() =>
      linearScale({ minimum: -1e308, maximum: 1e308 }, { minimum: 0, maximum: 10 }),
    ).toThrow(RangeError);
    expect(() => linearScale({ minimum: 0, maximum: 1 }, { minimum: NaN, maximum: 10 })).toThrow(
      RangeError,
    );
  });
});
