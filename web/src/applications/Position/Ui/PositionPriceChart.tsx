'use client';

import {
  usePositionCandles,
  usePositionHistory,
} from '@app/applications/Position/Api/usePositions.api';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import type { Candle, PositionEvent, RangeStatus } from '@binsight/shared';
import { cn, Skeleton, ToggleButton, ToggleButtonGroup, Tooltip } from '@heroui/react';
import { type Chart, dispose, init, LineType } from 'klinecharts';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface PositionChartInput {
  positionAddress: string;
  poolAddress: string;
  tokenX: string;
  tokenMint: string;
  minPrice?: number;
  maxPrice?: number;
  /** Open positions carry a live range status; closed ones don't. */
  rangeStatus?: RangeStatus;
  openedAt: number | null;
  closedAt: number | null;
}

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

/** Stable identity while the history request is in flight — a fresh `[]` per render would tear the
 *  chart down and rebuild it on every parent re-render. */
const NO_EVENTS: PositionEvent[] = [];

const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Short marker label per lifecycle event (kept terse so the timeline stays uncluttered). */
const EVENT_LABEL: Partial<Record<PositionEvent['kind'], string>> = {
  open: 'Open',
  deposit: 'Add',
  withdraw: 'Remove',
  claim: 'Fee',
  close: 'Close',
};

export const PositionPriceChart = (props: PositionChartInput) => {
  const { poolAddress, positionAddress } = props;
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [isFull, setFull] = useState(false);

  const candles = usePositionCandles(poolAddress, timeframe);
  const history = usePositionHistory(positionAddress);
  const hasCandles = (candles.data?.candles.length ?? 0) > 0;

  return (
    <div
      className={cn(
        'border-border border-t bg-background',
        isFull && 'fixed inset-0 z-50 flex flex-col border-0',
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <ToggleButtonGroup.Root
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[timeframe]}
          onSelectionChange={(keys) => {
            const [key] = [...keys];
            if (key != null) setTimeframe(key as Timeframe);
          }}
          aria-label="Chart timeframe"
        >
          {TIMEFRAMES.map((tf) => (
            <ToggleButton.Root key={tf} id={tf} className="tabular">
              {tf}
            </ToggleButton.Root>
          ))}
        </ToggleButtonGroup.Root>
        <Tooltip.Root>
          <ToggleButton.Root
            isIconOnly
            size="sm"
            variant="ghost"
            isSelected={isFull}
            onChange={setFull}
            aria-label={isFull ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFull ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </ToggleButton.Root>
          <Tooltip.Content>{isFull ? 'Exit fullscreen' : 'Fullscreen'}</Tooltip.Content>
        </Tooltip.Root>
      </div>

      {candles.isPending ? (
        <Skeleton.Root className={cn('w-full rounded-none', isFull ? 'flex-1' : 'h-[28rem]')} />
      ) : hasCandles ? (
        <KChart
          {...props}
          candles={candles.data?.candles ?? []}
          events={history.data?.events ?? NO_EVENTS}
          isFull={isFull}
        />
      ) : candles.isError ? (
        <StateMessage
          variant="error"
          title="Couldn't load chart"
          hint="The candle feed did not answer."
          onRetry={() => void candles.refetch()}
        />
      ) : (
        // Brand-new pool GeckoTerminal hasn't indexed yet → fall back to the dexscreener embed.
        <EmbedFallback poolAddress={poolAddress} isFull={isFull} />
      )}
    </div>
  );
};

interface KChartProps extends PositionChartInput {
  candles: Candle[];
  events: PositionEvent[];
  isFull: boolean;
}

const KChart = ({ candles, events, minPrice, maxPrice, rangeStatus, isFull }: KChartProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const up = cssVar('--success', '#3ddc8d');
    const down = cssVar('--danger', '#fb7185');
    const grid = cssVar('--border', 'rgba(255,255,255,0.08)');
    const axisText = cssVar('--muted', '#aeb4c0');
    // The range band mirrors the in-range/out-of-range tokens; the brand accent stays off the data.
    const band = rangeStatus === 'in' ? up : cssVar('--warning', '#f5b948');

    const chart = init(el, {
      locale: 'en-US',
      styles: {
        grid: { horizontal: { color: grid }, vertical: { show: false } },
        candle: {
          bar: {
            upColor: up,
            downColor: down,
            noChangeColor: axisText,
            upBorderColor: up,
            downBorderColor: down,
            upWickColor: up,
            downWickColor: down,
          },
          priceMark: {
            high: { color: axisText },
            low: { color: axisText },
            last: { text: { size: 11 } },
          },
        },
        xAxis: {
          axisLine: { color: grid },
          tickLine: { color: grid },
          tickText: { color: axisText },
        },
        yAxis: {
          axisLine: { color: grid },
          tickLine: { color: grid },
          tickText: { color: axisText },
        },
        separator: { color: grid },
        crosshair: {
          horizontal: { text: { backgroundColor: grid } },
          vertical: { text: { backgroundColor: grid } },
        },
        indicator: { lastValueMark: { show: false } },
        // Kill KLineChart's default blue (#1677FF) on overlays — theme the range lines + markers.
        overlay: {
          point: {
            color: band,
            borderColor: 'transparent',
            activeColor: band,
            activeBorderColor: 'transparent',
            radius: 3,
          },
          line: { color: band, size: 1 },
          polygon: { color: band, borderColor: band },
          arc: { color: band },
          text: { color: axisText, backgroundColor: 'transparent', size: 10 },
          rectText: {
            color: cssVar('--foreground', '#f1f3f6'),
            backgroundColor: cssVar('--surface-secondary', '#1f2631'),
            borderColor: band,
            borderSize: 1,
            borderRadius: 2,
            paddingLeft: 4,
            paddingRight: 4,
            paddingTop: 2,
            paddingBottom: 2,
          },
        },
      },
    });
    if (!chart) return;
    chartRef.current = chart;
    // Memecoin prices are tiny (1e-5…1e-9); at the default 2-decimal precision KLineChart rounds them
    // to 0.00 and the y-axis collapses (candles vanish). Adapt the precision to the data's magnitude.
    const lows = candles.map((c) => c.low).filter((v) => v > 0);
    const minPx = lows.length > 0 ? Math.min(...lows) : 1;
    const precision = Math.min(16, Math.max(2, Math.ceil(-Math.log10(minPx)) + 3));
    chart.setPriceVolumePrecision(precision, 0);
    // VOL bars only (drop the default MA5/10/20 lines — keep it clean).
    chart.createIndicator({ name: 'VOL', calcParams: [] }, false, { id: 'pane_vol' });
    chart.applyNewData(
      candles.map((c) => ({
        timestamp: c.time * 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    );

    // Range band: dashed Upper/Lower lines (KLineChart labels them with the value on the y-axis).
    const priceLine = (value: number) =>
      chart.createOverlay({
        name: 'priceLine',
        lock: true,
        points: [{ value }],
        styles: { line: { color: band, style: LineType.Dashed, size: 1 }, text: { color: band } },
      });
    if (maxPrice) priceLine(maxPrice);
    if (minPrice) priceLine(minPrice);

    // Lifecycle markers — ONE per candle. Events are bucketed by candle TIME and collapsed to the
    // dominant action (close > open > remove > add > claim) — otherwise the labels stack on the same
    // bar and become an illegible mush. Colour-coded, no blue.
    const byTime = new Map(candles.map((c) => [c.time, c]));
    const claim = cssVar('--warning', '#f5b948');
    const PRIORITY: Record<string, number> = {
      close: 5,
      open: 4,
      withdraw: 3,
      deposit: 2,
      claim: 1,
    };
    const byBucket = new Map<number, { event: PositionEvent; value: number }>();
    for (const event of events) {
      if (!EVENT_LABEL[event.kind]) continue;
      const sec = Math.floor(event.at / 1000);
      const candle = byTime.get(sec) ?? nearestCandle(candles, sec);
      const key = candle ? candle.time : sec;
      const value = candle ? candle.high : (maxPrice ?? 0);
      const previous = byBucket.get(key);
      if (!previous || (PRIORITY[event.kind] ?? 0) > (PRIORITY[previous.event.kind] ?? 0)) {
        byBucket.set(key, { event, value });
      }
    }
    for (const { event, value } of byBucket.values()) {
      const label = EVENT_LABEL[event.kind];
      const color =
        event.kind === 'close' || event.kind === 'withdraw'
          ? down
          : event.kind === 'claim'
            ? claim
            : up;
      chart.createOverlay({
        name: 'simpleAnnotation',
        lock: true,
        points: [{ timestamp: event.at, value }],
        extendData: label,
        styles: {
          text: { color, backgroundColor: 'transparent', size: 10 },
          polygon: { color },
          line: { color },
        },
      });
    }

    return () => {
      dispose(el);
      chartRef.current = null;
    };
  }, [candles, events, minPrice, maxPrice, rangeStatus]);

  // Container resizes when toggling fullscreen → tell KLineChart to re-measure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `isFull` is the intentional trigger.
  useEffect(() => {
    chartRef.current?.resize();
  }, [isFull]);

  return <div ref={containerRef} className={cn('w-full', isFull ? 'flex-1' : 'h-[28rem]')} />;
};

/** Closest candle to a unix-second time (events rarely align exactly to a bar boundary). */
function nearestCandle<T extends { time: number }>(candles: T[], sec: number): T | undefined {
  let best: T | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candle of candles) {
    const delta = Math.abs(candle.time - sec);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candle;
    }
  }
  return best;
}

interface EmbedFallbackProps {
  poolAddress: string;
  isFull: boolean;
}

const EmbedFallback = ({ poolAddress, isFull }: EmbedFallbackProps) => (
  <iframe
    title="Price chart"
    loading="lazy"
    src={`https://dexscreener.com/solana/${poolAddress}?embed=1&theme=dark&trades=0&info=0`}
    className={cn('w-full', isFull ? 'flex-1' : 'h-[28rem]')}
  />
);
