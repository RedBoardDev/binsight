import { describe, expect, it } from 'vitest';
import { linePath, type Point, scale, smoothLinePath } from './chartScale';

/** Every number in an SVG path, in order. */
const numbers = (path: string): number[] => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe('scale', () => {
  it('maps the domain linearly onto the range', () => {
    const x = scale(0, 10, 0, 100);
    expect(x(0)).toBe(0);
    expect(x(5)).toBe(50);
    expect(x(10)).toBe(100);
  });

  it('supports an inverted range (SVG y grows downwards)', () => {
    const y = scale(0, 10, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(10)).toBe(0);
  });

  it('does not divide by zero on a flat domain', () => {
    const y = scale(3, 3, 0, 100);
    expect(y(3)).toBe(0);
    expect(Number.isFinite(y(4))).toBe(true);
  });
});

describe('linePath', () => {
  it('moves to the first point and draws lines to the rest', () => {
    expect(
      linePath([
        [0, 0],
        [1.234, 5],
        [2, 3.5],
      ]),
    ).toBe('M0.00,0.00 L1.23,5.00 L2.00,3.50');
  });

  it('is empty without points', () => {
    expect(linePath([])).toBe('');
  });
});

describe('smoothLinePath', () => {
  it('falls back to the polyline below three points', () => {
    const points: Point[] = [
      [0, 0],
      [10, 10],
    ];
    expect(smoothLinePath(points)).toBe(linePath(points));
  });

  it('draws one cubic segment per interval', () => {
    const path = smoothLinePath([
      [0, 0],
      [10, 5],
      [20, 20],
    ]);
    expect(path.startsWith('M0.00,0.00')).toBe(true);
    expect(path.match(/C/g)).toHaveLength(2);
    expect(path.endsWith('20.00,20.00')).toBe(true);
  });

  it('never overshoots its neighbours (monotone cubic)', () => {
    const points: Point[] = [
      [0, 0],
      [10, 100],
      [20, 100],
      [30, 0],
      [40, 50],
    ];
    const ys = numbers(smoothLinePath(points)).filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
  });

  it('keeps a flat stretch flat', () => {
    const path = smoothLinePath([
      [0, 5],
      [10, 5],
      [20, 5],
    ]);
    const ys = numbers(path).filter((_, i) => i % 2 === 1);
    expect(new Set(ys)).toEqual(new Set([5]));
  });
});
