import {
  type PulsePoint,
  pulseGeometry,
} from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const figure = (amount: string): Figure => {
  const value = parseDecimalString(amount);
  if (value === null) throw new Error('A sample needs a canonical decimal');
  return { exactness: 'complete', value: { amount: value, unit: 'sol' } };
};
const point = (bar: string, line: string): PulsePoint => ({
  start: '2026-10-01T00:00:00Z',
  bar: figure(bar),
  line: figure(line),
});
const unavailable: Figure = { exactness: 'unavailable', reasons: [{ code: 'zero_denominator' }] };
const DIMENSIONS = { width: 600, height: 236 };

describe('pulseGeometry', () => {
  it('draws no bars or curves for an empty series and keeps a finite zero line', () => {
    const geometry = pulseGeometry([], DIMENSIONS);
    expect(geometry.bars).toEqual([]);
    expect(geometry.strokes).toEqual([]);
    expect(geometry.areas).toEqual([]);
    expect(geometry.positions).toEqual([]);
    expect(Number.isFinite(geometry.zeroY)).toBe(true);
  });

  it('keeps a zero bar at zero height and a singleton curve as a point', () => {
    const geometry = pulseGeometry([point('0', '0')], DIMENSIONS);
    expect(geometry.bars[0]?.height).toBe(0);
    expect(geometry.bars[0]?.tone).toBe('neutral');
    expect(geometry.strokes[0]?.path).toBe(`M300,${geometry.zeroY}`);
    expect(geometry.areas).toEqual([]);
  });

  it('shares the bar and cumulative zero across signed series', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 30 }),
        (values) => {
          const geometry = pulseGeometry(
            values.map((value) => point(`${value}`, '0')),
            DIMENSIONS,
          );
          for (const sample of geometry.linePoints) {
            if (sample.exactness !== 'unavailable')
              expect(sample.point.y).toBeCloseTo(geometry.zeroY, 10);
          }
          for (const bar of geometry.bars) {
            expect(bar.y).toBeGreaterThanOrEqual(10 - 1e-10);
            expect(bar.y + bar.height).toBeLessThanOrEqual(geometry.bottom + 1e-10);
          }
        },
      ),
    );
  });

  it('draws separate curves and areas across unavailable values', () => {
    const geometry = pulseGeometry(
      [
        point('1', '1'),
        point('1', '2'),
        { start: 'missing', bar: unavailable, line: unavailable },
        point('1', '3'),
        point('1', '4'),
      ],
      DIMENSIONS,
    );
    expect(geometry.bars).toHaveLength(4);
    expect(geometry.strokes).toHaveLength(2);
    expect(geometry.areas).toHaveLength(2);
    expect(geometry.linePoints[2]).toEqual({ exactness: 'unavailable' });
  });

  it('anchors tiny visible bars at zero and keeps them within the plot', () => {
    const geometry = pulseGeometry(
      [point('1000', '1000'), point('0.000000001', '1000'), point('-0.000000001', '1000')],
      DIMENSIONS,
    );
    const positive = geometry.bars[1];
    const negative = geometry.bars[2];
    expect(positive).toBeDefined();
    expect(negative).toBeDefined();
    if (positive === undefined || negative === undefined) return;
    expect(positive.y + positive.height).toBeCloseTo(geometry.zeroY, 10);
    expect(negative.y).toBe(geometry.zeroY);
    expect(negative.y + negative.height).toBeLessThanOrEqual(geometry.bottom);
  });

  it('marks estimates and gaps nonrepresentable values without a zero fallback', () => {
    const amount = parseDecimalString('1');
    if (amount === null) throw new Error('An estimate needs a canonical decimal');
    const estimated: Figure = {
      exactness: 'estimated',
      value: { amount, unit: 'sol' },
      reasons: [{ code: 'zero_denominator' }],
    };
    const geometry = pulseGeometry(
      [
        { start: 'estimated', bar: estimated, line: estimated },
        point(`1${'0'.repeat(400)}`, `1${'0'.repeat(400)}`),
      ],
      DIMENSIONS,
    );
    expect(geometry.bars).toHaveLength(1);
    expect(geometry.strokes[0]?.style).toBe('dashed');
    expect(geometry.linePoints[1]).toEqual({ exactness: 'unavailable' });
  });

  it('rejects dimensions that cannot hold a finite plot', () => {
    expect(() => pulseGeometry([], { width: 0, height: 236 })).toThrow(RangeError);
    expect(() => pulseGeometry([], { width: 100, height: 32 })).toThrow(RangeError);
    expect(() => pulseGeometry([], { width: Infinity, height: 236 })).toThrow(RangeError);
  });
});
