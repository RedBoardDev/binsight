import {
  type ExactChartPoint,
  estimatedSegments,
} from '@app/applications/Shared/Chart/Domain/estimatedSegments';
import { monotonePath } from '@app/applications/Shared/Chart/Domain/monotonePath';
import { describe, expect, it } from 'vitest';

const complete = (x: number, y: number): ExactChartPoint => ({
  exactness: 'complete',
  point: { x, y },
});
const estimated = (x: number, y: number): ExactChartPoint => ({
  exactness: 'estimated',
  point: { x, y },
});

describe('estimatedSegments', () => {
  it('keeps an exact run as one solid curve and an uncertain run dashed', () => {
    expect(estimatedSegments([complete(0, 0), complete(10, 5)])).toEqual([
      {
        style: 'solid',
        path: monotonePath([
          { x: 0, y: 0 },
          { x: 10, y: 5 },
        ]),
      },
    ]);
    expect(
      estimatedSegments([estimated(0, 0), { exactness: 'partial', point: { x: 10, y: 5 } }])[0]
        ?.style,
    ).toBe('dashed');
  });

  it('shares the original cubics across continuous solid and dashed junctions', () => {
    const points = [
      complete(0, 0),
      complete(10, 4),
      estimated(20, 7),
      complete(30, 9),
      complete(40, 12),
    ];
    const strokes = estimatedSegments(points);
    expect(strokes.map((stroke) => stroke.style)).toEqual(['solid', 'dashed', 'solid']);
    const whole = monotonePath(
      points.flatMap((entry) => (entry.exactness === 'unavailable' ? [] : [entry.point])),
    );
    const joined = strokes
      .map((stroke, index) =>
        index === 0 ? stroke.path : stroke.path.slice(stroke.path.indexOf('C')),
      )
      .join('');
    expect(joined).toBe(whole);
    expect(strokes[1]?.path.startsWith('M10,4C')).toBe(true);
    expect(strokes[2]?.path.startsWith('M30,9C')).toBe(true);
  });

  it('breaks the curve across unavailable samples instead of bridging missing history', () => {
    const strokes = estimatedSegments([
      complete(0, 0),
      complete(10, 5),
      { exactness: 'unavailable' },
      estimated(30, 8),
      estimated(40, 9),
    ]);
    expect(strokes).toEqual([
      {
        style: 'solid',
        path: monotonePath([
          { x: 0, y: 0 },
          { x: 10, y: 5 },
        ]),
      },
      {
        style: 'dashed',
        path: monotonePath([
          { x: 30, y: 8 },
          { x: 40, y: 9 },
        ]),
      },
    ]);
  });

  it('handles empty, unavailable and singleton runs', () => {
    expect(estimatedSegments([])).toEqual([]);
    expect(estimatedSegments([{ exactness: 'unavailable' }])).toEqual([]);
    expect(estimatedSegments([estimated(3, 5)])).toEqual([{ style: 'dashed', path: 'M3,5' }]);
  });
});
