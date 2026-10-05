import { sparklineGeometry } from '@app/applications/Shared/Chart/Domain/sparklineGeometry';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';
import { describe, expect, it } from 'vitest';

const money = (amount: string): Extract<Figure, { exactness: 'complete' }> => {
  const value = parseDecimalString(amount);
  if (value === null) throw new Error('A test needs a canonical amount');
  return { exactness: 'complete', value: { amount: value, unit: 'sol' } };
};

describe('sparklineGeometry', () => {
  it('draws a centered constant point and an empty geometry without invented readings', () => {
    expect(sparklineGeometry([], 22)).toEqual({
      strokes: [],
      lastPoint: null,
      points: [],
      positions: [],
    });
    expect(sparklineGeometry([money('0')], 22).lastPoint).toEqual({ x: 50, y: 11 });
    const constant = sparklineGeometry([money('2'), money('2')], 22);
    expect(constant.lastPoint).toEqual({ x: 97, y: 11 });
  });

  it('keeps estimated segments dashed and unavailable gaps unbridged', () => {
    const estimated: Figure = { ...money('2'), exactness: 'estimated', reasons: [] };
    const unavailable: Figure = { exactness: 'unavailable', reasons: [] };
    const geometry = sparklineGeometry([money('1'), estimated, unavailable, money('3')], 22);
    expect(geometry.strokes).toHaveLength(2);
    expect(geometry.strokes[0]?.style).toBe('dashed');
    expect(geometry.strokes[1]?.path).toBe('M97,3');
    expect(sparklineGeometry([money('1'), unavailable], 22).lastPoint).toBeNull();
  });

  it('cuts an unrepresentable conversion and rejects a height that clips its point', () => {
    expect(sparklineGeometry([money('1'), money('9'.repeat(400))], 22).lastPoint).toBeNull();
    for (const height of [0, 6, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => sparklineGeometry([], height)).toThrow(RangeError);
  });

  it('uses pixel width for the interactive line while retaining every missing index', () => {
    const unavailable: Figure = { exactness: 'unavailable', reasons: [] };
    const geometry = sparklineGeometry([money('100'), unavailable, money('101')], 200, 600);
    expect(geometry.positions).toEqual([3, 300, 597]);
    expect(geometry.points[1]).toEqual({ exactness: 'unavailable' });
    expect(geometry.lastPoint).toEqual({ x: 597, y: 3 });
    expect(geometry.points[0]).toEqual({ exactness: 'complete', point: { x: 3, y: 197 } });
    for (const width of [0, 6, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => sparklineGeometry([], 22, width)).toThrow(RangeError);
  });
});
