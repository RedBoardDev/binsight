import { plotValue } from '@app/applications/Shared/Chart/Domain/plotValue';
import type { DecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { PriceQuote } from '@app/applications/Shared/Figure/Domain/figure';

export type PriceTimeframe = '5m' | '15m' | '1h' | '4h' | '1d';

export interface PriceCandle {
  readonly start: string;
  readonly open: DecimalString;
  readonly high: DecimalString;
  readonly low: DecimalString;
  readonly close: DecimalString;
  readonly volume: DecimalString | null;
}

export interface PriceRange {
  readonly from: string;
  readonly to: string | null;
  readonly lower: DecimalString;
  readonly upper: DecimalString;
}

export interface PriceChartEvent {
  readonly id: string;
  readonly time: string;
  readonly kind: 'open' | 'add' | 'remove' | 'claim' | 'rebalance' | 'close';
  readonly price: DecimalString | null;
}

export interface PriceChartSeries {
  readonly candles: readonly PriceCandle[];
  readonly quoteSymbol: PriceQuote;
  readonly ranges: readonly PriceRange[];
  readonly events: readonly PriceChartEvent[];
  readonly currentPrice?: DecimalString;
  readonly closedAt?: string;
  readonly timeframe: PriceTimeframe;
  readonly height?: number;
}

export interface PlottedCandle {
  readonly time: number;
  readonly sourceIndex: number;
  readonly prices: {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
  } | null;
}

const TIMEFRAME_SECONDS: Readonly<Record<PriceTimeframe, number>> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};
const MILLISECONDS_PER_SECOND = 1000;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export const chartTimestamp = (timestamp: string): number => {
  const milliseconds = Date.parse(timestamp.replace(/(\.\d{3})\d+Z$/, '$1Z'));
  if (!UTC_TIMESTAMP.test(timestamp) || !Number.isFinite(milliseconds)) {
    throw new RangeError('A candle chart needs UTC timestamps');
  }
  if (new Date(milliseconds).toISOString().slice(0, 19) !== timestamp.slice(0, 19)) {
    throw new RangeError('A candle chart needs real calendar dates');
  }
  return milliseconds / MILLISECONDS_PER_SECOND;
};

export const timeframeSeconds = (timeframe: PriceTimeframe): number => TIMEFRAME_SECONDS[timeframe];

export const plotCandles = (candles: readonly PriceCandle[]): readonly PlottedCandle[] => {
  let previousTime = Number.NEGATIVE_INFINITY;
  return candles.map((candle, sourceIndex) => {
    const time = chartTimestamp(candle.start);
    if (time <= previousTime) throw new RangeError('Candles must have unique ascending times');
    previousTime = time;
    const open = plotValue(candle.open);
    const high = plotValue(candle.high);
    const low = plotValue(candle.low);
    const close = plotValue(candle.close);
    const prices =
      open === null || high === null || low === null || close === null
        ? null
        : { open, high, low, close };
    return { time, sourceIndex, prices };
  });
};

// Fractional logical indices locate range changes between candles without inventing market prices.
export const candleLogicalIndex = (
  times: readonly number[],
  time: number,
  timeframe: PriceTimeframe,
): number | null => {
  const first = times[0];
  if (first === undefined) return null;
  const step = timeframeSeconds(timeframe);
  if (time <= first) return (time - first) / step;
  for (let index = 1; index < times.length; index += 1) {
    const right = times[index];
    const left = times[index - 1];
    if (left !== undefined && right !== undefined && time <= right) {
      return index - 1 + (time - left) / (right - left);
    }
  }
  const last = times.at(-1);
  return last === undefined ? null : times.length - 1 + (time - last) / step;
};
