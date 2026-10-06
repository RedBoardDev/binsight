import type { PriceTimeframe } from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { PriceChart } from '@app/applications/Shared/Chart/Ui/PriceChart';
import { Button } from '@heroui/react';
import { useState } from 'react';
import {
  CANDLE_EVENT_SAMPLES,
  CANDLE_RANGE_SAMPLES,
  CANDLE_SAMPLES,
  CURRENT_PRICE_SAMPLE,
} from './candleSamples';

export const CandleSamples = () => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [closedIndex, setClosedIndex] = useState<number | null>(null);
  const [timeframe, setTimeframe] = useState<PriceTimeframe>('5m');
  const [chartHoverId, setChartHoverId] = useState<string | null>(null);
  const [timelineHoverId, setTimelineHoverId] = useState<string | null>(null);
  const activeEventId = timelineHoverId ?? chartHoverId;
  return (
    <div className="grid w-full gap-8">
      <PriceChart
        candles={CANDLE_SAMPLES}
        quoteSymbol="sol"
        ranges={CANDLE_RANGE_SAMPLES}
        events={CANDLE_EVENT_SAMPLES}
        currentPrice={CURRENT_PRICE_SAMPLE}
        timeframe={timeframe}
        label="Position candles sample"
        summary="Server market candles in SOL, two successive ranges and six neutral event markers"
        activeIndex={activeIndex}
        onScrub={setActiveIndex}
        activeEventId={activeEventId}
        onEventHover={setChartHoverId}
        onTimeframeChange={setTimeframe}
      />
      <fieldset aria-label="Sample price events" className="flex flex-wrap gap-2">
        {CANDLE_EVENT_SAMPLES.map((event) => (
          <Button
            key={event.id}
            size="sm"
            variant="ghost"
            aria-pressed={activeEventId === event.id}
            onPress={() => setTimelineHoverId(event.id)}
            onHoverStart={() => setTimelineHoverId(event.id)}
            onHoverEnd={() => setTimelineHoverId(null)}
          >
            {event.kind}
          </Button>
        ))}
      </fieldset>
      <PriceChart
        candles={CANDLE_SAMPLES}
        quoteSymbol="usdc"
        ranges={CANDLE_RANGE_SAMPLES}
        events={CANDLE_EVENT_SAMPLES}
        currentPrice={CURRENT_PRICE_SAMPLE}
        timeframe="5m"
        closedAt="2026-10-01T03:55:01Z"
        label="Closed position candles sample"
        summary="A closed position in USDC with its closing line and a margin after closure"
        activeIndex={closedIndex}
        onScrub={setClosedIndex}
      />
    </div>
  );
};
