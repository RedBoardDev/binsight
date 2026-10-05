import {
  type ChartPoint,
  monotonePath,
  monotoneSegments,
} from '@app/applications/Shared/Chart/Domain/monotonePath';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const evaluateCubic = (values: readonly number[], progress: number): number => {
  const [start = 0, first = 0, second = 0, end = 0] = values;
  const remaining = 1 - progress;
  return (
    remaining ** 3 * start +
    3 * remaining ** 2 * progress * first +
    3 * remaining * progress ** 2 * second +
    progress ** 3 * end
  );
};

const emittedCubics = (points: readonly ChartPoint[]): readonly (readonly number[])[] =>
  monotonePath(points)
    .split('C')
    .slice(1)
    .map((command, index) => {
      const start = points[index];
      const coordinates = command.split(/[ ,]/).map(Number);
      return [start?.y ?? 0, coordinates[1] ?? NaN, coordinates[3] ?? NaN, coordinates[5] ?? NaN];
    });

describe('monotonePath', () => {
  it('emits no path for no points and a move for one point', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([{ x: 2, y: 5 }])).toBe('M2,5');
  });

  it('keeps a constant series flat and passes through each sample', () => {
    const points = [
      { x: 0, y: 5 },
      { x: 6, y: 5 },
      { x: 9, y: 5 },
    ];
    expect(monotonePath(points)).toBe('M0,5C2,5 4,5 6,5C7,5 8,5 9,5');
    for (const segment of monotoneSegments(points)) {
      expect(segment.firstControl.y).toBe(5);
      expect(segment.secondControl.y).toBe(5);
    }
  });

  it('never overshoots or reverses between endpoints in the emitted SVG cubics', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 1, max: 500 }),
            y: fc.integer({ min: -10000, max: 10000 }),
          }),
          { minLength: 2, maxLength: 30 },
        ),
        (samples) => {
          let x = 0;
          const points = samples.map(({ gap, y }) => {
            x += gap;
            return { x, y };
          });
          for (const values of emittedCubics(points)) {
            const start = values[0] ?? 0;
            const end = values[3] ?? 0;
            const minimum = Math.min(start, end);
            const maximum = Math.max(start, end);
            let previous = start;
            for (let sample = 0; sample <= 40; sample += 1) {
              const value = evaluateCubic(values, sample / 40);
              expect(value).toBeGreaterThanOrEqual(minimum - 1e-8);
              expect(value).toBeLessThanOrEqual(maximum + 1e-8);
              expect((value - previous) * Math.sign(end - start)).toBeGreaterThanOrEqual(-1e-8);
              previous = value;
            }
          }
        },
      ),
    );
  });

  it('keeps a shared tangent across unevenly spaced segments and flattens turns', () => {
    const segments = monotoneSegments([
      { x: 0, y: 0 },
      { x: 10, y: 8 },
      { x: 30, y: 9 },
      { x: 40, y: 2 },
    ]);
    const first = segments[0];
    const second = segments[1];
    const third = segments[2];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (first === undefined || second === undefined || third === undefined) return;
    const arriving = (first.end.y - first.secondControl.y) / (first.end.x - first.secondControl.x);
    const departing =
      (second.firstControl.y - second.start.y) / (second.firstControl.x - second.start.x);
    expect(arriving).toBeCloseTo(departing, 12);
    expect(second.secondControl.y).toBe(second.end.y);
    expect(third.firstControl.y).toBe(third.start.y);
  });

  it('rejects duplicate or unordered x and nonfinite coordinates instead of inventing a curve', () => {
    expect(() =>
      monotonePath([
        { x: 1, y: 0 },
        { x: 1, y: 5 },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      monotonePath([
        { x: 2, y: 0 },
        { x: 1, y: 5 },
      ]),
    ).toThrow(RangeError);
    expect(() => monotonePath([{ x: 0, y: NaN }])).toThrow(RangeError);
    expect(() =>
      monotonePath([
        { x: 0, y: 0 },
        { x: Number.MIN_VALUE, y: 1 },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      monotonePath([
        { x: -1e308, y: 0 },
        { x: 1e308, y: 1 },
      ]),
    ).toThrow(RangeError);
  });

  it('keeps finite controls when a nearly flat segment follows a steep one', () => {
    const points = [
      { x: 0, y: -1e100 },
      { x: 1, y: 0 },
      { x: 2, y: 1e-300 },
    ];
    for (const segment of monotoneSegments(points)) {
      expect(Number.isFinite(segment.firstControl.y)).toBe(true);
      expect(Number.isFinite(segment.secondControl.y)).toBe(true);
    }
    expect(monotonePath(points)).not.toMatch(/NaN|Infinity/);
  });
});
