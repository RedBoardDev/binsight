import type { PriceChartSeries } from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { ChartReadings } from '@app/applications/Shared/Chart/Ui/ChartReadings';
import type { PriceChartProps } from '@app/applications/Shared/Chart/Ui/PriceChart';
import { useCandleAxisTime } from '@app/applications/Shared/Chart/Ui/PriceChart/useCandleAxisTime';
import { useCandleReadings } from '@app/applications/Shared/Chart/Ui/PriceChart/useCandleReadings';
import { usePriceChart } from '@app/applications/Shared/Chart/Ui/PriceChart/usePriceChart';
import { useElementWidth } from '@app/applications/Shared/Chart/Ui/useElementWidth';
import { useScrubIndex } from '@app/applications/Shared/Chart/Ui/useScrubIndex';
import { priceWithSubscriptZeros } from '@app/applications/Shared/Figure/Domain/formatPrice';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { useLingui } from '@lingui/react/macro';
import { memo, useCallback, useId, useMemo, useRef } from 'react';

const MemoizedChartReadings = memo(ChartReadings);

const NO_EVENT_HOVER = (): void => undefined;
interface LightweightPriceChartProps extends PriceChartProps {
  readonly height: number;
}

export const LightweightPriceChart = (props: LightweightPriceChartProps) => {
  const { t } = useLingui();
  const source = useMemo<PriceChartSeries>(
    () => ({
      candles: props.candles,
      ranges: props.ranges,
      events: props.events,
      quoteSymbol: props.quoteSymbol,
      timeframe: props.timeframe,
      ...(props.closedAt === undefined ? {} : { closedAt: props.closedAt }),
      ...(props.currentPrice === undefined ? {} : { currentPrice: props.currentPrice }),
    }),
    [
      props.candles,
      props.ranges,
      props.events,
      props.quoteSymbol,
      props.timeframe,
      props.closedAt,
      props.currentPrice,
    ],
  );
  const formatAxisTime = useCandleAxisTime();
  const { ref, width } = useElementWidth();
  const { formatDateTime } = useDateFormatters();
  const format = useFigureFormatter();
  // The price scale is a canvas: tiny prices count their zeros in subscript digits there, as
  // everywhere else in the app, instead of a raw 0.000000001520.
  const formatPrice = useCallback(
    (amount: Parameters<typeof format.price>[0]['amount']) =>
      priceWithSubscriptZeros(format.price({ amount, quote: props.quoteSymbol })),
    [format, props.quoteSymbol],
  );
  const { describePoint, renderReadout } = useCandleReadings(source, props.describeStatus);
  const selected = props.activeIndex ?? props.candles.length - 1;
  const summaryId = useId();
  const sliderRef = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => props.candles.map((candle) => candle.start), [props.candles]);
  const { onKeyDown, onFocus, onBlur } = useScrubIndex({
    positions: keys.map((_, index) => index),
    width,
    activeIndex: props.activeIndex,
    onScrub: props.onScrub,
  });
  usePriceChart({
    element: ref,
    source,
    width,
    height: props.height,
    activeIndex: props.activeIndex,
    activeEventId: props.activeEventId ?? null,
    onScrub: props.onScrub,
    onEventHover: props.onEventHover ?? NO_EVENT_HOVER,
    formatPrice,
    formatTime: formatDateTime,
    formatAxisTime,
  });
  return (
    <>
      {props.candles.length === 0 && (
        <p className="py-6 text-body text-muted">{t`Price history is not available for this pool yet`}</p>
      )}
      <div
        className="relative"
        style={{ height: props.height }}
        onPointerDownCapture={(event) => {
          if (event.target instanceof Element && event.target.closest('a') !== null) return;
          sliderRef.current?.focus({ preventScroll: true });
        }}
      >
        <div
          ref={sliderRef}
          role="slider"
          aria-label={props.label}
          aria-describedby={summaryId}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, keys.length - 1)}
          aria-valuenow={Math.max(0, selected)}
          aria-valuetext={describePoint(selected)}
          aria-disabled={keys.length === 0}
          tabIndex={keys.length === 0 ? -1 : 0}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          className="pointer-events-none absolute inset-0 rounded-md"
        />
        <div ref={ref} className="h-full w-full" />
      </div>
      <figcaption id={summaryId} className="mt-3 min-h-6 text-small text-muted">
        {props.activeIndex === null ? props.summary : renderReadout(selected)}
      </figcaption>
      <MemoizedChartReadings keys={keys} label={props.label} describePoint={describePoint} />
    </>
  );
};
