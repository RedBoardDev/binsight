import type { PositionBin, PositionBins } from '@binsight/shared';
import { describe, expect, it } from 'vitest';
import {
  BIN_CHART_MAX_BARS,
  binChartBarCap,
  binChartContentWidth,
  binChartGeometry,
} from './binChart';

const bins = (activeBinId: number, list: PositionBin[]): PositionBins => ({
  slot: 1,
  activeBinId,
  binStep: 10,
  tokenXMint: 'x',
  tokenYMint: 'y',
  bins: list,
});

const bin = (binId: number, amountX: number, amountY: number, price = 1): PositionBin => ({
  binId,
  price,
  amountX,
  amountY,
});

describe('binChartBarCap', () => {
  it('fits one bar per minimum slot, capped', () => {
    expect(binChartBarCap(20)).toBe(5);
    expect(binChartBarCap(1_000)).toBe(BIN_CHART_MAX_BARS);
  });

  it('never drops below one bar', () => {
    expect(binChartBarCap(2)).toBe(1);
    expect(binChartBarCap(0)).toBe(1);
    expect(binChartBarCap(Number.NaN)).toBe(1);
  });
});

describe('binChartContentWidth', () => {
  it('shrinks a narrow range to its bars at the maximum slot', () => {
    expect(binChartContentWidth(5, 112)).toBe(40);
  });

  it('fills the slot once there are enough bars', () => {
    expect(binChartContentWidth(44, 112)).toBe(112);
  });

  it('is 0 with nothing to draw', () => {
    expect(binChartContentWidth(0, 112)).toBe(0);
    expect(binChartContentWidth(5, 0)).toBe(0);
  });
});

describe('binChartGeometry', () => {
  // Quote-side liquidity: amountY + amountX × price → 2, 1, 4, 0.
  const position = bins(3, [bin(1, 2, 0), bin(2, 0, 1), bin(3, 0, 4), bin(4, 0, 0)]);

  it('draws one bar per bin, normalised to the tallest, split at the active bin', () => {
    expect(binChartGeometry(position)).toEqual({
      bars: [
        { binId: 1, height: 0.5, belowActive: true },
        { binId: 2, height: 0.25, belowActive: true },
        { binId: 3, height: 1, belowActive: false },
        { binId: 4, height: 0, belowActive: false },
      ],
      activeFraction: 0.5,
    });
  });

  it('sums bins into buckets when there are more bins than bars', () => {
    const { bars } = binChartGeometry(position, 2);
    expect(bars).toEqual([
      { binId: 2, height: 0.75, belowActive: true },
      { binId: 4, height: 1, belowActive: false },
    ]);
  });

  it('prices token X at the bin price', () => {
    const { bars } = binChartGeometry(bins(1, [bin(1, 1, 0, 3), bin(2, 0, 3)]));
    expect(bars.map((bar) => bar.height)).toEqual([1, 1]);
  });

  it('keeps a sliver of liquidity visible, and an empty bin empty', () => {
    const { bars } = binChartGeometry(bins(1, [bin(1, 0, 100), bin(2, 0, 0.01), bin(3, 0, 0)]));
    expect(bars.map((bar) => bar.height)).toEqual([1, 0.06, 0]);
  });

  it('pins the marker to the edge when the price is out of range', () => {
    const range = [bin(10, 0, 1), bin(11, 0, 1)];
    expect(binChartGeometry(bins(50, range)).activeFraction).toBe(1);
    expect(binChartGeometry(bins(1, range)).activeFraction).toBe(0);
  });

  it('is empty without bins', () => {
    expect(binChartGeometry(bins(0, []))).toEqual({ bars: [], activeFraction: 0 });
    expect(binChartGeometry(position, 0)).toEqual({ bars: [], activeFraction: 0 });
  });
});
