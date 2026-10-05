import { eventMarkers } from '@app/applications/Shared/Chart/Domain/Candle/eventMarkers';
import {
  candleLogicalIndex,
  chartTimestamp,
  type PriceChartSeries,
  plotCandles,
} from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import {
  candleThemeOptions,
  priceChartOptions,
  readPriceChartTheme,
} from '@app/applications/Shared/Chart/Ui/PriceChart/chartTheme';
import { EventMarkerPrimitive } from '@app/applications/Shared/Chart/Ui/PriceChart/EventMarkerPrimitive';
import { RangeBandPrimitive } from '@app/applications/Shared/Chart/Ui/PriceChart/rangeBandPrimitive';
import type { DecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { useReducedMotion } from '@app/applications/Shared/Motion/Ui/useReducedMotion';
import { themeStore } from '@app/core/theme/themeStore';
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  TickMarkType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { type RefObject, useEffect, useMemo, useRef } from 'react';

interface ChartRuntime {
  readonly chart: IChartApi;
  readonly series: ISeriesApi<'Candlestick'>;
  readonly markers: ISeriesMarkersPluginApi<Time>;
  readonly band: RangeBandPrimitive;
  readonly eventLetters: EventMarkerPrimitive;
}

interface PriceChartEffect {
  readonly element: RefObject<HTMLDivElement | null>;
  readonly source: PriceChartSeries;
  readonly width: number;
  readonly height: number;
  readonly activeIndex: number | null;
  readonly activeEventId: string | null;
  readonly onScrub: (index: number | null) => void;
  readonly onEventHover: (id: string | null) => void;
  readonly formatPrice: (price: DecimalString) => string;
  readonly formatTime: (timestamp: string) => string;
  readonly formatAxisTime: (timestamp: string, scale: 'date' | 'time') => string;
}

const CANDLE_EDGE_PADDING_BARS = 2;

const fitPosition = (
  runtime: ChartRuntime,
  source: Pick<PriceChartSeries, 'candles' | 'closedAt' | 'timeframe'>,
): void => {
  const times = source.candles.map((candle) => chartTimestamp(candle.start));
  const first = times[0];
  if (first === undefined) return;
  if (source.closedAt === undefined) {
    runtime.chart.timeScale().setVisibleLogicalRange({
      from: -CANDLE_EDGE_PADDING_BARS,
      to: Math.max(0.5, times.length - 0.5),
    });
    return;
  }
  const close = chartTimestamp(source.closedAt);
  const end = close + Math.max(0, close - first) * 0.1;
  const logical = candleLogicalIndex(times, end, source.timeframe);
  if (logical !== null)
    runtime.chart
      .timeScale()
      .setVisibleLogicalRange({ from: -CANDLE_EDGE_PADDING_BARS, to: Math.max(0.5, logical) });
};

export const usePriceChart = (options: PriceChartEffect): void => {
  const runtime = useRef<ChartRuntime | null>(null);
  const lastPointerIndex = useRef<number | null>(null);
  const fittedSeriesKey = useRef<string | null>(null);
  const isReducedMotion = useReducedMotion();
  const { source, formatPrice, formatTime, formatAxisTime, activeEventId } = options;
  const { candles, closedAt, timeframe } = source;
  const plottedCandles = useMemo(() => plotCandles(candles), [candles]);
  const latest = useRef({ ...options, plottedCandles });
  latest.current = { ...options, plottedCandles };

  useEffect(() => {
    const element = latest.current.element.current;
    if (element === null) return;
    // StrictMode reinstalls effects; a new SDK instance has never received the previous fit.
    fittedSeriesKey.current = null;
    lastPointerIndex.current = null;
    const theme = readPriceChartTheme(element);
    const chart = createChart(element, {
      ...priceChartOptions(theme),
      width: latest.current.width,
      height: latest.current.height,
    });
    const series = chart.addSeries(CandlestickSeries, candleThemeOptions(theme));
    const markers = createSeriesMarkers(series, [], { autoScale: false });
    const band = new RangeBandPrimitive(latest.current.source, theme, latest.current.formatPrice);
    series.attachPrimitive(band);
    const eventLetters = new EventMarkerPrimitive(theme);
    series.attachPrimitive(eventLetters);
    const current = { chart, series, markers, band, eventLetters };
    runtime.current = current;
    let frame: number | null = null;
    const move = (event: MouseEventParams) => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        const source = latest.current.source;
        const time = event.time;
        const index =
          typeof time === 'number'
            ? source.candles.findIndex((candle) => chartTimestamp(candle.start) === time)
            : -1;
        lastPointerIndex.current = index < 0 ? null : index;
        latest.current.onScrub(lastPointerIndex.current);
        const id = event.hoveredInfo?.objectId;
        latest.current.onEventHover(
          typeof id === 'string' && source.events.some((candidate) => candidate.id === id)
            ? id
            : null,
        );
      });
    };
    const applyTheme = () => {
      const nextTheme = readPriceChartTheme(element);
      chart.applyOptions(priceChartOptions(nextTheme));
      series.applyOptions(candleThemeOptions(nextTheme));
      band.update(latest.current.source, nextTheme, latest.current.formatPrice);
      const currentMarkers = eventMarkers(
        latest.current.source.events,
        latest.current.plottedCandles,
        latest.current.source.timeframe,
      );
      eventLetters.update(currentMarkers, nextTheme, latest.current.activeEventId);
    };
    const unsubscribe = themeStore.subscribe(applyTheme);
    const doubleClick = () => fitPosition(current, latest.current.source);
    chart.subscribeCrosshairMove(move);
    element.addEventListener('dblclick', doubleClick);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
      chart.unsubscribeCrosshairMove(move);
      element.removeEventListener('dblclick', doubleClick);
      series.detachPrimitive(band);
      series.detachPrimitive(eventLetters);
      markers.detach();
      chart.remove();
      runtime.current = null;
    };
  }, []);

  useEffect(() => {
    runtime.current?.chart.resize(options.width, options.height);
  }, [options.width, options.height]);

  useEffect(() => {
    const current = runtime.current;
    if (current === null) return;
    current.series.setData(
      plottedCandles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        ...candle.prices,
      })),
    );
    const seriesKey = `${timeframe}:${closedAt ?? ''}:${candles[0]?.start ?? ''}`;
    if (fittedSeriesKey.current !== seriesKey) {
      fitPosition(current, { candles, ...(closedAt === undefined ? {} : { closedAt }), timeframe });
      fittedSeriesKey.current = seriesKey;
    }
  }, [candles, plottedCandles, closedAt, timeframe]);

  useEffect(() => {
    const current = runtime.current;
    const element = latest.current.element.current;
    if (current === null || element === null) return;
    const theme = readPriceChartTheme(element);
    current.band.update(source, theme, formatPrice);
    const plottedMarkers = eventMarkers(source.events, plottedCandles, source.timeframe);
    current.eventLetters.update(plottedMarkers, theme, activeEventId);
    current.markers.setMarkers(
      plottedMarkers.map((marker) => ({
        time: marker.time as UTCTimestamp,
        id: marker.id,
        shape: 'circle',
        color: theme.background,
        size: 0,
        ...(marker.price === null
          ? { position: 'aboveBar' as const }
          : { position: 'atPriceMiddle' as const, price: marker.price }),
      })),
    );
    current.chart.applyOptions({
      kineticScroll: { mouse: !isReducedMotion, touch: !isReducedMotion },
      timeScale: {
        tickMarkFormatter: (time: Time, type: TickMarkType) =>
          typeof time === 'number'
            ? formatAxisTime(
                new Date(time * 1000).toISOString(),
                type <= TickMarkType.DayOfMonth ? 'date' : 'time',
              )
            : '',
      },
      localization: {
        timeFormatter: (time: Time) =>
          typeof time === 'number' ? formatTime(new Date(time * 1000).toISOString()) : '',
      },
    });
  }, [
    source,
    plottedCandles,
    activeEventId,
    formatPrice,
    formatTime,
    formatAxisTime,
    isReducedMotion,
  ]);

  useEffect(() => {
    const current = runtime.current;
    if (options.activeIndex !== null && options.activeIndex === lastPointerIndex.current) return;
    const candle = options.activeIndex === null ? undefined : plottedCandles[options.activeIndex];
    if (current === null) return;
    if (candle?.prices === null || candle === undefined) current.chart.clearCrosshairPosition();
    else
      current.chart.setCrosshairPosition(
        candle.prices.close,
        candle.time as UTCTimestamp,
        current.series,
      );
  }, [options.activeIndex, plottedCandles]);
};
