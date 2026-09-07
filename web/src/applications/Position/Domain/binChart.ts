import type { PositionBins } from '@binsight/shared';

/**
 * A faithful port of the macOS client's `BinChart.swift` geometry, so the same position draws the
 * same curve on every client. Change one, change both.
 */

/** Hard ceiling on the bar count, whatever the width. A DLMM position tops out at 70 bins; past this
 *  the curve gains no readable detail. Bucketing SUMS liquidity, so the shape survives. */
export const BIN_CHART_MAX_BARS = 44;

/** Narrowest slot a bar may occupy before the curve stops reading as a shape. */
const MIN_BAR_SLOT = 4;

/** Widest slot a bar may occupy. Without this a narrow range (a 5-bin position) stretched its bars
 *  across the whole slot and rendered as a handful of fat blocks — unreadable AS A CURVE, and
 *  visually louder than a 60-bin position. Past this the chart keeps its bar size and simply gets
 *  narrower, which is the honest depiction: fewer bins IS less chart. */
const MAX_BAR_SLOT = 8;

/** Shortest bar drawn for a bucket that holds *some* liquidity, as a share of the height. An empty
 *  bucket stays at 0 — the gap between deposited and empty bins must stay visible. */
const MIN_BAR_HEIGHT = 0.06;

export interface BinBar {
  /** Highest bin id in the bucket — its stable identity across re-renders. */
  binId: number;
  /** 0…1 share of the chart height, normalised against the tallest bucket. */
  height: number;
  /** The bucket sits entirely below the active bin (token-X side); otherwise it is at or above it
   *  (token-Y / SOL side). Drives the bar colour. */
  belowActive: boolean;
}

export interface BinChartGeometry {
  bars: BinBar[];
  /** 0…1 horizontal position of the live-price marker (0 = range low, 1 = range high). */
  activeFraction: number;
}

/** How many buckets a chart of `width` may draw: as many as fit above the minimum slot, capped at
 *  {@link BIN_CHART_MAX_BARS}, never below one. */
export function binChartBarCap(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.min(BIN_CHART_MAX_BARS, Math.max(1, Math.floor(width / MIN_BAR_SLOT)));
}

/** Width the bars actually occupy inside an `available`-wide slot: the full slot once there are
 *  enough bars to fill it, otherwise only what `bars` need at the maximum slot each. */
export function binChartContentWidth(bars: number, available: number): number {
  if (bars <= 0 || !Number.isFinite(available) || available <= 0) return 0;
  return Math.min(available, bars * MAX_BAR_SLOT);
}

/**
 * A bin's liquidity is measured in the QUOTE token (`amountY + amountX * price`) so an X-heavy and a
 * Y-heavy bin are comparable on one axis — the same measure the detail histogram uses.
 */
export function binChartGeometry(
  data: PositionBins,
  maxBars = BIN_CHART_MAX_BARS,
): BinChartGeometry {
  const bins = data.bins;
  if (bins.length === 0 || maxBars <= 0) return { bars: [], activeFraction: 0 };

  const barCount = Math.min(bins.length, maxBars);
  const sums = new Array<number>(barCount).fill(0);
  // Highest bin id landing in each bucket — a bucket counts as "below active" only when ALL of its
  // bins are, so the colour split never claims the active bin sits further right than it does.
  const upperBinId = new Array<number>(barCount).fill(Number.NEGATIVE_INFINITY);

  bins.forEach((bin, i) => {
    // Even, contiguous split of the range over the bars. Integer maths keeps the last bin in the
    // last bucket, so no bin is ever dropped.
    const slot = Math.min(barCount - 1, Math.floor((i * barCount) / bins.length));
    sums[slot] = (sums[slot] ?? 0) + bin.amountY + bin.amountX * bin.price;
    upperBinId[slot] = Math.max(upperBinId[slot] ?? Number.NEGATIVE_INFINITY, bin.binId);
  });

  const peak = Math.max(0, ...sums);
  const bars = sums.map((sum, i) => {
    const share = peak > 0 ? sum / peak : 0;
    const upper = upperBinId[i] ?? Number.NEGATIVE_INFINITY;
    return {
      binId: Number.isFinite(upper) ? upper : i,
      height: share > 0 ? Math.max(MIN_BAR_HEIGHT, share) : 0,
      belowActive: upper < data.activeBinId,
    };
  });

  // Marker = the share of the range below the live price. Out of range on the high side (no bin at
  // or above the active bin) pins it to the right edge; on the low side the first bin already
  // qualifies, which pins it left.
  const firstAtOrAbove = bins.findIndex((bin) => bin.binId >= data.activeBinId);
  const activeFraction = firstAtOrAbove < 0 ? 1 : firstAtOrAbove / bins.length;

  return { bars, activeFraction };
}
