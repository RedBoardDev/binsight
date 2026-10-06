import type {
  PriceCandle,
  PriceChartEvent,
  PriceRange,
} from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';

const price = (amount: string) => {
  const value = parseDecimalString(amount);
  if (value === null) throw new Error('A price fixture must be canonical');
  return value;
};
const START_MS = Date.parse('2026-10-01T00:00:00Z');
const FIVE_MINUTES_MS = 300000;
const OHLC = [
  ['0.0000000011', '0.00000000135', '0.00000000104', '0.0000000013'],
  ['0.0000000013', '0.00000000139', '0.00000000118', '0.00000000124'],
  ['0.00000000124', '0.00000000143', '0.0000000012', '0.0000000014'],
  ['0.0000000014', '0.00000000146', '0.00000000127', '0.0000000013'],
  ['0.0000000013', '0.00000000153', '0.00000000128', '0.00000000149'],
  ['0.00000000149', '0.00000000155', '0.00000000132', '0.00000000137755666'],
] as const;

export const CANDLE_SAMPLES: readonly PriceCandle[] = Array.from({ length: 48 }, (_, index) => {
  const sample = OHLC[index % OHLC.length];
  if (sample === undefined) throw new Error('The OHLC fixture is missing');
  const [open, high, low, close] = sample;
  return {
    start: new Date(START_MS + index * FIVE_MINUTES_MS).toISOString(),
    open: price(open),
    high: price(high),
    low: price(low),
    close: price(close),
    volume: null,
  };
});
export const CURRENT_PRICE_SAMPLE = price('0.00000000137755666');
export const CANDLE_RANGE_SAMPLES: readonly PriceRange[] = [
  {
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-01T02:00:00Z',
    lower: price('0.00000000112'),
    upper: price('0.00000000138'),
  },
  {
    from: '2026-10-01T02:00:00Z',
    to: null,
    lower: price('0.00000000125'),
    upper: price('0.00000000152'),
  },
];
export const CANDLE_EVENT_SAMPLES: readonly PriceChartEvent[] = [
  { id: 'open', time: '2026-10-01T00:00:01Z', kind: 'open', price: price('0.0000000011') },
  { id: 'add', time: '2026-10-01T00:35:02Z', kind: 'add', price: price('0.0000000013') },
  { id: 'remove', time: '2026-10-01T01:10:03Z', kind: 'remove', price: price('0.0000000014') },
  { id: 'claim', time: '2026-10-01T01:45:04Z', kind: 'claim', price: null },
  {
    id: 'rebalance',
    time: '2026-10-01T02:00:00Z',
    kind: 'rebalance',
    price: price('0.0000000013'),
  },
  { id: 'close', time: '2026-10-01T03:55:01Z', kind: 'close', price: price('0.00000000137755666') },
];
