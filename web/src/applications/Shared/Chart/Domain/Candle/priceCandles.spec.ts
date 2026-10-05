import {
  candleLogicalIndex,
  chartTimestamp,
  type PriceCandle,
  plotCandles,
} from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { describe, expect, it } from 'vitest';

const decimal = (amount: string) => {
  const value = parseDecimalString(amount);
  if (value === null) throw new Error('A fixture must be canonical');
  return value;
};
const candle = (start: string, amount = '0.00000000123456789'): PriceCandle => ({
  start,
  open: decimal(amount),
  high: decimal(amount),
  low: decimal(amount),
  close: decimal(amount),
  volume: null,
});

describe('plotCandles', () => {
  it('accepts wire timestamps with nanoseconds while preserving their original string', () => {
    const source = candle('2026-10-01T00:00:00.123456789Z');
    expect(plotCandles([source])[0]?.time).toBe(1790812800.123);
    expect(source.start).toBe('2026-10-01T00:00:00.123456789Z');
  });
  it('keeps exact original strings and every source index while approximating tiny prices for drawing', () => {
    const source = [candle('2026-10-01T00:00:00Z'), candle('2026-10-01T00:05:00Z')];
    expect(plotCandles(source)).toEqual([
      {
        time: 1790812800,
        sourceIndex: 0,
        prices: {
          open: 1.23456789e-9,
          high: 1.23456789e-9,
          low: 1.23456789e-9,
          close: 1.23456789e-9,
        },
      },
      {
        time: 1790813100,
        sourceIndex: 1,
        prices: {
          open: 1.23456789e-9,
          high: 1.23456789e-9,
          low: 1.23456789e-9,
          close: 1.23456789e-9,
        },
      },
    ]);
    expect(source[0]?.close).toBe('0.00000000123456789');
  });

  it('keeps nonrepresentable prices as whitespace instead of dropping their date or source index', () => {
    const source = [
      candle('2026-10-01T00:00:00Z', '9'.repeat(400)),
      candle('2026-10-01T00:05:00Z', `0.${'0'.repeat(400)}1`),
    ];
    expect(plotCandles(source).map((point) => point.prices)).toEqual([null, null]);
    expect(plotCandles([])).toEqual([]);
  });

  it('rejects duplicate or unordered candle times and malformed timestamps', () => {
    expect(() =>
      plotCandles([candle('2026-10-01T00:00:00Z'), candle('2026-10-01T00:00:00Z')]),
    ).toThrow(RangeError);
    expect(() =>
      plotCandles([candle('2026-10-02T00:00:00Z'), candle('2026-10-01T00:00:00Z')]),
    ).toThrow(RangeError);
    for (const time of ['bad', '2026-10-01', '2026-02-30T00:00:00Z', '2026-10-01T24:00:00Z'])
      expect(() => chartTimestamp(time)).toThrow(RangeError);
  });
});

describe('candleLogicalIndex', () => {
  it('places range boundaries between candles and extrapolates only time at both ends', () => {
    const times = [1000, 1300, 1900];
    expect(candleLogicalIndex(times, 1150, '5m')).toBe(0.5);
    expect(candleLogicalIndex(times, 1600, '5m')).toBe(1.5);
    expect(candleLogicalIndex(times, 700, '5m')).toBe(-1);
    expect(candleLogicalIndex(times, 2200, '5m')).toBe(3);
    expect(candleLogicalIndex([1000], 1300, '5m')).toBe(1);
    expect(candleLogicalIndex([], 1300, '5m')).toBeNull();
  });
});
