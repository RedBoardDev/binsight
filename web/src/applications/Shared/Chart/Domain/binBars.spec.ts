import { type BinChartSource, binBars } from '@app/applications/Shared/Chart/Domain/binBars';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const chart = (count: number, active = Math.floor(count / 2)): BinChartSource => ({
  active_bin_id: active,
  lower_bin_id: 0,
  upper_bin_id: Math.max(0, count - 1),
  bars: Array.from({ length: count }, (_, index) => ({
    bin_id: index,
    base: index < active ? '0' : '2',
    quote: index > active ? '0' : '3',
    height: index % 2 === 0 ? '0.5' : '1',
  })),
});

describe('binBars', () => {
  it('keeps every source once within 44 drawn bars and reserves the active source', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (count) => {
        const source = chart(count);
        const geometry = binBars(source);
        expect(geometry.bars.length).toBeLessThanOrEqual(44);
        expect(geometry.bars.flatMap((bar) => bar.sourceIndices)).toEqual(
          Array.from({ length: count }, (_, i) => i),
        );
        expect(geometry.bars.filter((bar) => bar.isActive).map((bar) => bar.sourceIndices)).toEqual(
          [[source.active_bin_id]],
        );
        for (const bar of geometry.bars) {
          expect(bar.heightRatio).toBeGreaterThanOrEqual(0.06);
          expect(bar.heightRatio).toBeLessThanOrEqual(1);
          expect(bar.leftRatio).toBeGreaterThanOrEqual(0);
          expect(bar.leftRatio + bar.widthRatio).toBeLessThanOrEqual(1 + 1e-12);
          const sides = bar.sourceIndices.map((index) => source.bars[index]);
          expect(
            sides.every(
              (entry) =>
                bar.side === 'mixed' ||
                (bar.side === 'base' ? entry?.quote === '0' : entry?.base === '0'),
            ),
          ).toBe(true);
        }
      }),
    );
  });

  it('uses the maximum normalized drawing height without summing source amounts', () => {
    const geometry = binBars(chart(70, 35));
    const group = geometry.bars.find((bar) => bar.sourceIndices.length > 1);
    expect(group?.heightRatio).toBe(1);
    expect(group?.sourceIndices.length).toBeGreaterThan(1);
  });

  it('compresses 70 alternating token sides as mixed groups while keeping every source and the active bin', () => {
    const source = chart(70, 35);
    const alternating = {
      ...source,
      bars: source.bars.map((bar, index) => ({
        ...bar,
        base: index % 2 === 0 ? '0' : '2',
        quote: index % 2 === 0 ? '3' : '0',
      })),
    };
    const geometry = binBars(alternating);
    expect(geometry.bars.length).toBeLessThanOrEqual(44);
    expect(geometry.bars.flatMap((bar) => bar.sourceIndices)).toEqual(
      Array.from({ length: 70 }, (_, index) => index),
    );
    expect(geometry.bars.filter((bar) => bar.isActive).map((bar) => bar.sourceIndices)).toEqual([
      [35],
    ]);
    expect(geometry.bars.some((bar) => bar.side === 'mixed' && bar.sourceIndices.length > 1)).toBe(
      true,
    );
    expect(geometry.bars.every((bar) => bar.heightRatio <= 1)).toBe(true);
  });

  it('marks an active bin between the first ids of server groups and preserves mixed sources', () => {
    const source = {
      ...chart(3),
      active_bin_id: 15,
      upper_bin_id: 29,
      bars: [
        { bin_id: 0, base: '0', quote: '100', height: '0.3' },
        { bin_id: 10, base: '9007199254740993', quote: '0.000000001', height: '1' },
        { bin_id: 20, base: '8', quote: '0', height: '0.8' },
      ],
    };
    const geometry = binBars(source);
    expect(geometry.bars[1]).toMatchObject({
      sourceIndices: [1],
      firstBinId: 10,
      lastBinId: 19,
      side: 'mixed',
      isActive: true,
    });
    expect(geometry.markerRatio).toBeCloseTo(15.5 / 30);
  });

  it('anchors an above-range marker at the right and a below-range marker at the left', () => {
    expect(binBars(chart(3, 4))).toMatchObject({ markerRatio: 1, range: 'above' });
    expect(binBars(chart(3, -1))).toMatchObject({ markerRatio: 0, range: 'below' });
    const sparse = {
      ...chart(1, 5),
      upper_bin_id: 10,
      bars: [{ bin_id: 5, base: '2', quote: '0', height: '0' }],
    };
    const last = binBars(sparse).bars[0];
    expect((last?.leftRatio ?? 0) + (last?.widthRatio ?? 0)).toBe(1);
    expect(last?.heightRatio).toBe(0.06);
  });

  it('shows only a baseline when no server bars are available', () => {
    expect(binBars(chart(0))).toMatchObject({ bars: [], markerRatio: null });
  });

  it('rejects duplicate, unordered, outside and invalid server values instead of inventing a range', () => {
    const source = chart(2);
    for (const bars of [source.bars.toReversed(), [source.bars[0], source.bars[0]]]) {
      expect(() => binBars({ ...source, bars: bars.filter((bar) => bar !== undefined) })).toThrow(
        RangeError,
      );
    }
    for (const height of ['1.1', '-0.1', 'NaN', '1e-2'])
      expect(() =>
        binBars({ ...source, bars: [{ bin_id: 0, base: '0', quote: '1', height }] }),
      ).toThrow(RangeError);
    expect(() =>
      binBars({ ...source, bars: [{ bin_id: 3, base: '0', quote: '1', height: '1' }] }),
    ).toThrow(RangeError);
    expect(() =>
      binBars({ ...source, bars: [{ bin_id: 0, base: '0.0', quote: '1', height: '1' }] }),
    ).toThrow(RangeError);
    expect(() => binBars({ ...source, upper_bin_id: -1 })).toThrow(RangeError);
  });
});
