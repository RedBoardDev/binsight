import { type CreditDay, stackedBars } from '@app/applications/Shared/Chart/Domain/stackedBars';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const OPTIONS = {
  cycle: { start: '2026-10-17T00:00:00Z', end: '2026-11-17T00:00:00Z' },
  dailyBudget: 100,
  width: 620,
  height: 236,
};

describe('stackedBars', () => {
  it('uses the server cycle across two months and leaves missing calendar days empty', () => {
    const geometry = stackedBars(
      [
        { day: '2026-10-17', used: 40 },
        { day: '2026-10-31', used: 100 },
        { day: '2026-11-01', used: 120 },
        { day: '2026-11-16', used: 0 },
      ],
      OPTIONS,
    );
    expect(geometry.positions).toEqual([10, 290, 310, 610]);
    expect(geometry.bars).toHaveLength(4);
    expect(geometry.bars[3]?.height).toBe(0);
    expect(geometry.budgetY).toBeGreaterThan(10);
    expect(geometry.budgetY).toBeLessThan(geometry.bottom);
  });

  it('keeps the budget and zero usage finite without inventing a day', () => {
    const empty = stackedBars([], { ...OPTIONS, dailyBudget: 0 });
    expect(empty.bars).toEqual([]);
    expect(empty.positions).toEqual([]);
    expect(empty.budgetY).toBe(empty.bottom);
    const one = stackedBars([{ day: '2026-10-17', used: 0, segments: [] }], {
      ...OPTIONS,
      dailyBudget: 0,
    });
    expect(one.bars[0]?.height).toBe(0);
  });

  it('keeps three adjacent days readable inside a sparse full cycle on a phone', () => {
    const days = ['2026-10-17', '2026-10-18', '2026-10-19'].map((day) => ({ day, used: 1 }));
    const geometry = stackedBars(days, { ...OPTIONS, width: 343 });
    expect(geometry.bars).toHaveLength(3);
    expect(geometry.positions).toHaveLength(3);
    expect(geometry.labels).toEqual([0]);
    const sparse = stackedBars(
      [...days, { day: '2026-11-01', used: 1 }, { day: '2026-11-02', used: 1 }],
      { ...OPTIONS, width: 343 },
    );
    expect(sparse.labels).toEqual([0, 4]);
  });

  it('places leap day using supplied UTC boundaries without shifting it to another time zone', () => {
    const geometry = stackedBars([{ day: '2024-02-29', used: 1 }], {
      ...OPTIONS,
      width: 580,
      cycle: { start: '2024-02-17T00:00:00.000Z', end: '2024-03-17T00:00:00+00:00' },
    });
    expect(geometry.positions).toEqual([250]);
  });

  it('rejects nonexistent, duplicate, unordered and outside days including the exclusive reset day', () => {
    for (const days of [
      [{ day: '2026-11-17', used: 1 }],
      [{ day: '2026-10-16', used: 1 }],
      [{ day: '2026-10-32', used: 1 }],
      [{ day: '2026-2-17', used: 1 }],
      [
        { day: '2026-10-17', used: 1 },
        { day: '2026-10-17', used: 1 },
      ],
      [
        { day: '2026-11-01', used: 1 },
        { day: '2026-10-31', used: 1 },
      ],
    ])
      expect(() => stackedBars(days, OPTIONS)).toThrow(RangeError);
    expect(() =>
      stackedBars([{ day: '2026-02-29', used: 1 }], {
        ...OPTIONS,
        cycle: { start: '2026-02-17T00:00:00Z', end: '2026-03-17T00:00:00Z' },
      }),
    ).toThrow(RangeError);
  });

  it('refuses fractional counters, mismatched segments and unsafe sums before drawing', () => {
    for (const used of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => stackedBars([{ day: '2026-10-17', used }], OPTIONS)).toThrow(RangeError);
    for (const segments of [
      [1, 2],
      [-1, 5],
      [0.5, 3.5],
      [Number.MAX_SAFE_INTEGER, 1],
    ])
      expect(() => stackedBars([{ day: '2026-10-17', used: 4, segments }], OPTIONS)).toThrow(
        RangeError,
      );
    expect(() => stackedBars([], { ...OPTIONS, dailyBudget: -1 })).toThrow(RangeError);
    expect(() =>
      stackedBars([], { ...OPTIONS, cycle: { ...OPTIONS.cycle, start: '2026-10-17T01:00:00Z' } }),
    ).toThrow(RangeError);
    expect(() =>
      stackedBars([], {
        ...OPTIONS,
        cycle: { start: OPTIONS.cycle.end, end: OPTIONS.cycle.start },
      }),
    ).toThrow(RangeError);
    expect(() => stackedBars([], { ...OPTIONS, height: 32 })).toThrow(RangeError);
  });

  it('keeps every stack inside the plot with segment heights equal to its total height', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 4 }), {
          maxLength: 31,
        }),
        (stacks) => {
          const days: CreditDay[] = stacks.map((segments, index) => ({
            day: new Date(Date.UTC(2026, 9, 17 + index)).toISOString().slice(0, 10),
            used: segments.reduce((sum, value) => sum + value, 0),
            segments,
          }));
          const geometry = stackedBars(days, OPTIONS);
          expect(geometry.bars).toHaveLength(days.length);
          for (const bar of geometry.bars) {
            expect(bar.x).toBeGreaterThanOrEqual(0);
            expect(bar.x + bar.width).toBeLessThanOrEqual(OPTIONS.width);
            expect(bar.y).toBeGreaterThanOrEqual(10);
            expect(bar.y + bar.height).toBeCloseTo(geometry.bottom);
            expect(bar.segments.reduce((sum, segment) => sum + segment.height, 0)).toBeCloseTo(
              bar.height,
            );
            for (const segment of bar.segments) {
              expect(segment.y).toBeGreaterThanOrEqual(10);
              expect(segment.y + segment.height).toBeLessThanOrEqual(geometry.bottom);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
