import { plotValue } from '@app/applications/Shared/Chart/Domain/plotValue';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';

export const MAX_DRAWN_BIN_BARS = 44;
export const MIN_BIN_HEIGHT_RATIO = 0.06;
const MIN_BIN_ID = -2_147_483_648;
const MAX_BIN_ID = 2_147_483_647;

export interface BinChartSource {
  readonly active_bin_id: number;
  readonly lower_bin_id: number;
  readonly upper_bin_id: number;
  readonly bars: readonly {
    readonly bin_id: number;
    readonly base: string;
    readonly quote: string;
    readonly height: string;
  }[];
}

export interface DrawnBinBar {
  readonly sourceIndices: readonly number[];
  readonly firstBinId: number;
  readonly lastBinId: number;
  readonly side: 'base' | 'quote' | 'mixed';
  readonly isActive: boolean;
  readonly heightRatio: number;
  readonly leftRatio: number;
  readonly widthRatio: number;
}

export interface BinGeometry {
  readonly bars: readonly DrawnBinBar[];
  readonly markerRatio: number | null;
  readonly range: 'in_range' | 'below' | 'above';
}

const assertBinChart = (chart: BinChartSource): void => {
  const ids = [chart.active_bin_id, chart.lower_bin_id, chart.upper_bin_id];
  if (
    ids.some((id) => !Number.isSafeInteger(id) || id < MIN_BIN_ID || id > MAX_BIN_ID) ||
    chart.lower_bin_id > chart.upper_bin_id
  )
    throw new RangeError('Bin ids must be safe integers in an ordered range');
  let previous = chart.lower_bin_id - 1;
  for (const bar of chart.bars) {
    if (
      !Number.isSafeInteger(bar.bin_id) ||
      bar.bin_id <= previous ||
      bar.bin_id < chart.lower_bin_id ||
      bar.bin_id > chart.upper_bin_id ||
      parseDecimalString(bar.base) === null ||
      parseDecimalString(bar.quote) === null ||
      bar.base.startsWith('-') ||
      bar.quote.startsWith('-')
    )
      throw new RangeError(
        'Bin bars must have ordered unique ids and canonical nonnegative amounts',
      );
    previous = bar.bin_id;
  }
};

const sourceBars = (chart: BinChartSource): DrawnBinBar[] => {
  const span = chart.upper_bin_id - chart.lower_bin_id + 1;
  return chart.bars.map((bar, index) => {
    const plotted = plotValue(bar.height);
    if (plotted === null || plotted < 0 || plotted > 1)
      throw new RangeError('A server bin height must be a canonical ratio from zero to one');
    // This is the drawing interval, not an inventory of individual bins: the server can
    // already have grouped its liquidity and only provides each group's first id.
    const lastBinId = (chart.bars[index + 1]?.bin_id ?? chart.upper_bin_id + 1) - 1;
    const isActive = chart.active_bin_id >= bar.bin_id && chart.active_bin_id <= lastBinId;
    const side = bar.base === '0' ? 'quote' : bar.quote === '0' ? 'base' : 'mixed';
    return {
      sourceIndices: [index],
      firstBinId: bar.bin_id,
      lastBinId,
      side,
      isActive,
      heightRatio: Math.max(MIN_BIN_HEIGHT_RATIO, plotted),
      leftRatio: (bar.bin_id - chart.lower_bin_id) / span,
      widthRatio: (lastBinId - bar.bin_id + 1) / span,
    };
  });
};

const sideRuns = (bars: readonly DrawnBinBar[]): DrawnBinBar[][] => {
  const runs: DrawnBinBar[][] = [];
  for (const bar of bars) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (previous === undefined || previous.side !== bar.side || previous.isActive || bar.isActive)
      runs.push([bar]);
    else run?.push(bar);
  }
  return runs;
};

const groupingRuns = (bars: readonly DrawnBinBar[]): DrawnBinBar[][] => {
  const sides = sideRuns(bars);
  if (sides.length <= MAX_DRAWN_BIN_BARS) return sides;
  // The contract allows alternating sides. When every transition cannot fit, keep the
  // active server group separate and identify each compressed mixed group with both colors.
  const runs: DrawnBinBar[][] = [];
  for (const bar of bars) {
    const run = runs.at(-1);
    if (run === undefined || bar.isActive || run.at(-1)?.isActive) runs.push([bar]);
    else run.push(bar);
  }
  return runs;
};

const runQuotas = (runs: readonly (readonly DrawnBinBar[])[]): number[] => {
  const quotas = runs.map(() => 1);
  const budget = Math.min(
    MAX_DRAWN_BIN_BARS,
    runs.reduce((sum, run) => sum + run.length, 0),
  );
  for (let assigned = runs.length; assigned < budget; assigned += 1) {
    let selected = -1;
    let largest = 0;
    for (const [index, run] of runs.entries()) {
      const quota = quotas[index] ?? 1;
      if (quota < run.length && run.length / quota > largest) {
        largest = run.length / quota;
        selected = index;
      }
    }
    if (selected < 0) break;
    quotas[selected] = (quotas[selected] ?? 1) + 1;
  }
  return quotas;
};

const mergePixels = (bars: readonly DrawnBinBar[]): DrawnBinBar => {
  const first = bars[0];
  const last = bars.at(-1);
  if (first === undefined || last === undefined)
    throw new RangeError('A bin group cannot be empty');
  // A maximum of drawing heights is not an aggregated liquidity amount. Keep every server
  // index: showing one source's price or quantities as the whole group would invent a total.
  return {
    ...first,
    sourceIndices: bars.flatMap((bar) => bar.sourceIndices),
    side: bars.every((bar) => bar.side === first.side) ? first.side : 'mixed',
    lastBinId: last.lastBinId,
    heightRatio: bars.reduce((height, bar) => Math.max(height, bar.heightRatio), 0),
    widthRatio: last.leftRatio + last.widthRatio - first.leftRatio,
  };
};

export const binBars = (chart: BinChartSource): BinGeometry => {
  assertBinChart(chart);
  const runs = groupingRuns(sourceBars(chart));
  const quotas = runQuotas(runs);
  const bars = runs.flatMap((run, index) => {
    const size = Math.ceil(run.length / (quotas[index] ?? 1));
    const groups: DrawnBinBar[] = [];
    for (let start = 0; start < run.length; start += size)
      groups.push(mergePixels(run.slice(start, start + size)));
    return groups;
  });
  const range =
    chart.active_bin_id < chart.lower_bin_id
      ? 'below'
      : chart.active_bin_id > chart.upper_bin_id
        ? 'above'
        : 'in_range';
  const markerRatio =
    bars.length === 0
      ? null
      : range === 'below'
        ? 0
        : range === 'above'
          ? 1
          : (chart.active_bin_id - chart.lower_bin_id + 0.5) /
            (chart.upper_bin_id - chart.lower_bin_id + 1);
  return { bars, markerRatio, range };
};
