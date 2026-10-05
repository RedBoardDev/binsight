import type { PriceChartSeries } from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { readPriceChartTheme } from '@app/applications/Shared/Chart/Ui/PriceChart/chartTheme';
import { RangeBandPrimitive } from '@app/applications/Shared/Chart/Ui/PriceChart/rangeBandPrimitive';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { IPrimitivePaneRenderer, SeriesAttachedParameter, Time } from 'lightweight-charts';
import { describe, expect, it, vi } from 'vitest';

const price = (amount: string) => {
  const value = parseDecimalString(amount);
  if (value === null) throw new Error('A fixture needs a canonical price');
  return value;
};
const SOURCE: PriceChartSeries = {
  quoteSymbol: 'sol',
  timeframe: '5m',
  currentPrice: price('2.123456789123456789'),
  events: [],
  candles: ['2026-10-01T00:00:00Z', '2026-10-01T00:05:00Z'].map((start) => ({
    start,
    open: price('1'),
    high: price('3'),
    low: price('1'),
    close: price('2'),
    volume: null,
  })),
  ranges: [
    {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-01T00:05:00Z',
      lower: price('1'),
      upper: price('2'),
    },
    { from: '2026-10-01T00:05:00Z', to: null, lower: price('2'), upper: price('3') },
  ],
};

describe('RangeBandPrimitive', () => {
  it('draws successive server ranges and returns only server-string axis labels', () => {
    const theme = readPriceChartTheme(document.documentElement);
    const format = vi.fn((value: string) => `exact:${value}`);
    const primitive = new RangeBandPrimitive(SOURCE, theme, format);
    const attachment = {
      chart: { timeScale: () => ({ logicalToCoordinate: (logical: number) => 50 + logical * 20 }) },
      series: { priceToCoordinate: (value: number) => 200 - value * 20 },
      requestUpdate: vi.fn(),
    };
    primitive.attached(attachment as unknown as SeriesAttachedParameter<Time>);
    primitive.updateAllViews();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    };
    const target = {
      useMediaCoordinateSpace: (draw: (scope: unknown) => void) =>
        draw({ context, mediaSize: { height: 200 } }),
    };
    const renderer = primitive.paneViews()[0]?.renderer();
    renderer?.drawBackground?.(target as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]);
    expect(context.fillRect.mock.calls).toEqual([
      [50, 160, 20, 20],
      [70, 140, 20, 20],
    ]);
    expect(primitive.priceAxisViews().map((label) => label.text())).toEqual([
      'exact:2',
      'exact:3',
      'exact:2.123456789123456789',
    ]);
    expect(format).toHaveBeenCalledWith('2.123456789123456789');
    expect(primitive.autoscaleInfo()).toEqual({ priceRange: { minValue: 1, maxValue: 3 } });
  });

  it('draws a closing line at its time coordinate and omits a current-price label for a closed position', () => {
    const theme = readPriceChartTheme(document.documentElement);
    const primitive = new RangeBandPrimitive(
      { ...SOURCE, closedAt: '2026-10-01T00:05:00.123456789Z' },
      theme,
      (value) => value,
    );
    const logicalToCoordinate = vi.fn((logical: number) =>
      Number.isInteger(logical) ? logical * 10 : 0,
    );
    primitive.attached({
      chart: { timeScale: () => ({ logicalToCoordinate }) },
      series: { priceToCoordinate: () => 100 },
      requestUpdate: vi.fn(),
    } as unknown as SeriesAttachedParameter<Time>);
    primitive.updateAllViews();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
    };
    const target = {
      useMediaCoordinateSpace: (draw: (scope: unknown) => void) =>
        draw({ context, mediaSize: { height: 200 } }),
    };
    primitive
      .paneViews()[0]
      ?.renderer()
      ?.draw(target as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]);
    expect(context.moveTo.mock.calls[0]?.[0]).toBeCloseTo(10.0041, 4);
    expect(context.lineTo.mock.calls[0]?.[1]).toBe(200);
    expect(primitive.priceAxisViews()).toHaveLength(2);
    primitive
      .paneViews()[0]
      ?.renderer()
      ?.drawBackground?.(target as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(context.fillRect.mock.calls[1]?.[2]).toBeCloseTo(0.0041, 4);
    expect(logicalToCoordinate.mock.calls.every(([logical]) => Number.isInteger(logical))).toBe(
      true,
    );
    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.priceAxisViews()).toEqual([]);
  });
});
