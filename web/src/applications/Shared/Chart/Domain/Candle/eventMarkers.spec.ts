import { eventMarkers } from '@app/applications/Shared/Chart/Domain/Candle/eventMarkers';
import type {
  PlottedCandle,
  PriceChartEvent,
} from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { describe, expect, it } from 'vitest';

const candle: PlottedCandle = {
  time: 1790812800,
  sourceIndex: 0,
  prices: { open: 1, high: 1, low: 1, close: 1 },
};
const price = parseDecimalString('0.00000000123456789');
if (price === null) throw new Error('The price fixture must be canonical');
const event: PriceChartEvent = { id: 'opening', time: '2026-10-01T00:00:01Z', kind: 'open', price };

describe('eventMarkers', () => {
  it('does not move an event in a missing market bucket onto an older candle', () => {
    const source = [candle, { ...candle, time: candle.time + 600, sourceIndex: 1 }];
    expect(eventMarkers([{ ...event, time: '2026-10-01T00:07:00Z' }], source, '5m')).toEqual([]);
    expect(
      eventMarkers([{ ...event, time: '2026-10-01T00:10:01.123456789Z' }], source, '5m')[0]?.time,
    ).toBe(candle.time + 600);
  });
  it('places each letter on its containing candle and uses only the supplied event price for height', () => {
    expect(eventMarkers([event], [candle], '5m')).toEqual([
      { id: 'opening', time: 1790812800, letter: 'O', price: 1.23456789e-9 },
    ]);
    const kinds = ['open', 'add', 'remove', 'claim', 'rebalance', 'close'] as const;
    expect(
      eventMarkers(
        kinds.map((kind) => ({ ...event, id: kind, kind })),
        [candle],
        '5m',
      ).map((marker) => marker.letter),
    ).toEqual(['O', 'A', 'R', 'C', 'B', 'X']);
  });

  it('keeps null prices without substituting a candle price and ignores events outside market data', () => {
    expect(eventMarkers([{ ...event, price: null }], [candle], '5m')[0]?.price).toBeNull();
    for (const time of ['2026-09-30T23:59:59Z', '2026-10-01T00:05:00Z'])
      expect(eventMarkers([{ ...event, time }], [candle], '5m')).toEqual([]);
    expect(eventMarkers([event], [], '5m')).toEqual([]);
    expect(eventMarkers([event], [{ ...candle, prices: null }], '5m')).toEqual([]);
  });

  it('rejects duplicate event identifiers rather than highlighting an unrelated timeline node', () => {
    expect(() => eventMarkers([event, event], [candle], '5m')).toThrow(RangeError);
  });
});
