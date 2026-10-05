import type {
  CandlestickSeriesPartialOptions,
  ChartOptions,
  DeepPartial,
} from 'lightweight-charts';
import { ColorType, CrosshairMode, LineStyle } from 'lightweight-charts';

export interface PriceChartTheme {
  readonly accent: string;
  readonly foreground: string;
  readonly background: string;
  readonly muted: string;
  readonly faint: string;
  readonly gain: string;
  readonly loss: string;
  readonly grid: string;
  readonly fontFamily: string;
}

export const readPriceChartTheme = (element: HTMLElement): PriceChartTheme => {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    accent: token('--accent'),
    foreground: token('--foreground'),
    background: token('--background'),
    muted: token('--muted'),
    faint: token('--faint'),
    gain: token('--gain'),
    loss: token('--loss'),
    grid: token('--border-subtle'),
    fontFamily: style.fontFamily,
  };
};

export const priceChartOptions = (theme: PriceChartTheme): DeepPartial<ChartOptions> => ({
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    textColor: theme.faint,
    fontSize: 11,
    fontFamily: theme.fontFamily,
    attributionLogo: true,
  },
  grid: { vertLines: { visible: false }, horzLines: { color: theme.grid } },
  rightPriceScale: {
    borderVisible: false,
    ticksVisible: false,
    minimumWidth: 90,
    scaleMargins: { top: 0.18, bottom: 0.12 },
  },
  timeScale: {
    borderVisible: false,
    timeVisible: true,
    secondsVisible: false,
    lockVisibleTimeRangeOnResize: true,
  },
  crosshair: {
    mode: CrosshairMode.Magnet,
    vertLine: { color: theme.faint, style: LineStyle.Dotted, labelVisible: false },
    horzLine: { color: theme.faint, style: LineStyle.Dotted, labelVisible: false },
  },
  // Native labels receive approximate drawing numbers. Only primitives may supply exact server labels.
  localization: {
    priceFormatter: () => '',
    percentageFormatter: () => '',
    tickmarksPriceFormatter: (prices: number[]) => prices.map(() => ''),
  },
  handleScroll: { vertTouchDrag: false, horzTouchDrag: true },
});

export const candleThemeOptions = (theme: PriceChartTheme): CandlestickSeriesPartialOptions => ({
  upColor: theme.gain,
  downColor: theme.loss,
  borderVisible: false,
  wickUpColor: wickColor(theme.gain),
  wickDownColor: wickColor(theme.loss),
  lastValueVisible: false,
  priceLineVisible: false,
  priceFormat: {
    type: 'custom',
    minMove: 1e-12,
    formatter: () => '',
    tickmarksFormatter: (prices: number[]) => prices.map(() => ''),
  },
});

// The SDK accepts sRGB rgb()/rgba(); resolve theme tokens through the browser first.
const wickColor = (color: string): string => {
  const probe = document.createElement('span');
  probe.style.color = color;
  probe.hidden = true;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(resolved);
  if (rgb === null) throw new Error('An opaque candle theme color must resolve to sRGB');
  return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0.7)`;
};
