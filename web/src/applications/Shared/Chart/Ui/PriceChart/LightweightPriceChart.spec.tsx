import type {
  PriceCandle,
  PriceChartSeries,
} from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { LightweightPriceChart } from '@app/applications/Shared/Chart/Ui/PriceChart/LightweightPriceChart';
import { PriceChartHeader } from '@app/applications/Shared/Chart/Ui/PriceChart/PriceChartHeader';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { AppProviders } from '@app/core/AppProviders';
import { themeStore } from '@app/core/theme/themeStore';
import { createTestQueryClient } from '@test/createTestQueryClient';
import { renderWithProviders } from '@test/renderWithProviders';
import { configure, getConfig, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const series = {
    setData: vi.fn(),
    applyOptions: vi.fn(),
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
    priceToCoordinate: vi.fn(),
  };
  const scale = {
    fitContent: vi.fn(),
    setVisibleLogicalRange: vi.fn(),
    logicalToCoordinate: vi.fn(),
  };
  const chart = {
    addSeries: vi.fn((_definition: unknown, _options: unknown) => series),
    timeScale: () => scale,
    applyOptions: vi.fn(),
    resize: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    remove: vi.fn(),
    clearCrosshairPosition: vi.fn(),
    setCrosshairPosition: vi.fn(),
  };
  const markers = { setMarkers: vi.fn(), detach: vi.fn() };
  return {
    series,
    scale,
    chart,
    markers,
    createChart: vi.fn((_element: unknown, _options: unknown) => chart),
  };
});
vi.mock('lightweight-charts', () => ({
  createChart: sdk.createChart,
  CandlestickSeries: {},
  createSeriesMarkers: () => sdk.markers,
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Magnet: 1 },
  LineStyle: { Dotted: 1 },
  TickMarkType: { DayOfMonth: 2 },
}));

const price = (amount: string) => {
  const value = parseDecimalString(amount);
  if (value === null) throw new Error('A fixture needs a canonical price');
  return value;
};
const candle = (start: string, amount: string): PriceCandle => ({
  start,
  open: price(amount),
  high: price(amount),
  low: price(amount),
  close: price(amount),
  volume: null,
});
const SERIES: PriceChartSeries = {
  quoteSymbol: 'usdc',
  timeframe: '5m',
  ranges: [],
  events: [],
  candles: [
    candle('2026-10-01T00:00:00Z', '0.00000000123456789'),
    candle('2026-10-01T00:05:00Z', '1.0004999999999999999'),
  ],
};
const TestChart = ({ source = SERIES }: { readonly source?: PriceChartSeries }) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const props = {
    ...source,
    height: 260,
    label: 'Price sample',
    summary: 'Market candles',
    activeIndex,
    onScrub: setActiveIndex,
  };
  return (
    <figure aria-label="Price sample">
      <PriceChartHeader source={props} />
      <LightweightPriceChart {...props} />
    </figure>
  );
};

afterEach(() => {
  displayPreferenceStore.setAmountsHidden(false);
  vi.clearAllMocks();
});

describe('LightweightPriceChart', () => {
  it('fits every new SDK instance after StrictMode tears down and reinstalls its effects', () => {
    const { reactStrictMode } = getConfig();
    configure({ reactStrictMode: true });
    try {
      renderWithProviders(<TestChart />);
      expect(sdk.createChart).toHaveBeenCalledTimes(2);
      expect(sdk.chart.remove).toHaveBeenCalledTimes(1);
      expect(sdk.scale.setVisibleLogicalRange).toHaveBeenCalledTimes(2);
      expect(sdk.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: -2, to: 1.5 });
    } finally {
      configure({ reactStrictMode });
    }
  });

  it('reads original server OHLC strings by keyboard and keeps an equivalent accessible table', async () => {
    renderWithProviders(<TestChart />);
    const slider = screen.getByRole('slider', { name: 'Price sample' });
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard('{Home}');
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Open: 0.000000001235'),
    );
    await user.keyboard('{End}');
    // Plotting rounds to 1.0005; formatting that float would incorrectly display 1.001.
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('Open: 1.000'));
    expect(slider).not.toHaveAttribute('aria-valuetext', expect.stringContaining('1.001'));
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('USDC'));
    const table = screen.getByRole('table', { name: 'Price sample' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table.parentElement).toHaveClass('sr-only');
    expect(sdk.createChart).toHaveBeenCalledTimes(1);
    expect(sdk.series.setData).toHaveBeenCalledTimes(1);
  });

  it('updates series and theme without recreating the chart and tears down its listeners on unmount', () => {
    const queryClient = createTestQueryClient();
    const view = renderWithProviders(<TestChart />, { queryClient });
    const removeBefore = sdk.chart.remove.mock.calls.length;
    const fitsBefore = sdk.scale.setVisibleLogicalRange.mock.calls.length;
    view.rerender(
      <AppProviders queryClient={queryClient}>
        <TestChart source={{ ...SERIES, candles: SERIES.candles.slice(0, 1) }} />
      </AppProviders>,
    );
    expect(sdk.series.setData).toHaveBeenCalledTimes(2);
    expect(sdk.scale.setVisibleLogicalRange.mock.calls.length).toBe(fitsBefore);
    themeStore.setPreference('dark');
    expect(sdk.chart.applyOptions).toHaveBeenCalled();
    expect(sdk.series.applyOptions).toHaveBeenCalled();
    expect(sdk.createChart).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(sdk.chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(1);
    expect(sdk.series.detachPrimitive).toHaveBeenCalledTimes(2);
    expect(sdk.markers.detach).toHaveBeenCalledTimes(1);
    expect(sdk.chart.remove.mock.calls.length).toBe(removeBefore + 1);
  });

  it('keeps market prices visible under amount masking and disables an empty chart', async () => {
    displayPreferenceStore.setAmountsHidden(true);
    const queryClient = createTestQueryClient();
    const view = renderWithProviders(<TestChart />, { queryClient });
    expect(screen.getByRole('table')).toHaveTextContent('0.000000001235');
    view.rerender(
      <AppProviders queryClient={queryClient}>
        <TestChart source={{ ...SERIES, candles: [] }} />
      </AppProviders>,
    );
    expect(screen.getByText('Price history is not available for this pool yet')).toBeVisible();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('slider')).toHaveAttribute('tabindex', '-1');
  });

  it('hides all native numeric price labels and reads a current price only when explicitly supplied', () => {
    renderWithProviders(
      <TestChart source={{ ...SERIES, currentPrice: price('0.00000000123456789') }} />,
    );
    const options: unknown = sdk.createChart.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      layout: { attributionLogo: true },
      timeScale: { lockVisibleTimeRangeOnResize: true },
      crosshair: { vertLine: { labelVisible: false }, horzLine: { labelVisible: false } },
    });
    const seriesOptions: unknown = sdk.chart.addSeries.mock.calls[0]?.[1];
    expect(seriesOptions).toMatchObject({
      lastValueVisible: false,
      priceLineVisible: false,
      priceFormat: { type: 'custom', minMove: 1e-12 },
    });
    expect(screen.getByText('Price')).toBeVisible();
    expect(screen.getByText('in USDC')).toBeVisible();
  });

  it('fits a closed position with a time margin and suppresses the current price heading', () => {
    renderWithProviders(
      <TestChart
        source={{ ...SERIES, currentPrice: price('1'), closedAt: '2026-10-01T00:05:00Z' }}
      />,
    );
    expect(sdk.scale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: -2, to: 1.1 });
    expect(sdk.scale.fitContent).not.toHaveBeenCalled();
    expect(screen.getByText('Price').parentElement).not.toHaveTextContent('1.000');
  });
});
