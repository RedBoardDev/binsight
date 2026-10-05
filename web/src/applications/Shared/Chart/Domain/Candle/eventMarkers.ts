import {
  chartTimestamp,
  type PlottedCandle,
  type PriceChartEvent,
  type PriceTimeframe,
  timeframeSeconds,
} from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { plotValue } from '@app/applications/Shared/Chart/Domain/plotValue';

const EVENT_LETTERS: Readonly<Record<PriceChartEvent['kind'], string>> = {
  open: 'O',
  add: 'A',
  remove: 'R',
  claim: 'C',
  rebalance: 'B',
  close: 'X',
};

export interface PlottedEventMarker {
  readonly id: string;
  readonly time: number;
  readonly letter: string;
  readonly price: number | null;
}

export const eventMarkers = (
  events: readonly PriceChartEvent[],
  candles: readonly PlottedCandle[],
  timeframe: PriceTimeframe,
): readonly PlottedEventMarker[] => {
  const first = candles[0]?.time;
  const last = candles.at(-1)?.time;
  if (first === undefined || last === undefined) return [];
  const end = last + timeframeSeconds(timeframe);
  const identifiers = new Set<string>();
  return events
    .flatMap((event) => {
      if (identifiers.has(event.id)) throw new RangeError('Chart event identifiers must be unique');
      identifiers.add(event.id);
      const time = chartTimestamp(event.time);
      if (time < first || time >= end) return [];
      const candle = candles.findLast((candidate) => candidate.time <= time);
      if (
        candle?.prices === null ||
        candle === undefined ||
        time >= candle.time + timeframeSeconds(timeframe)
      )
        return [];
      return [
        {
          id: event.id,
          time: candle.time,
          letter: EVENT_LETTERS[event.kind],
          price: event.price === null ? null : plotValue(event.price),
        },
      ];
    })
    .sort((left, right) => left.time - right.time);
};
