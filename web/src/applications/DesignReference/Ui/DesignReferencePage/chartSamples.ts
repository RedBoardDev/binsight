import type { PulsePoint } from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type {
  Figure,
  FigureReason,
  PercentFigure,
} from '@app/applications/Shared/Figure/Domain/figure';

export interface ChartSample extends PulsePoint {
  readonly bar: Figure;
  readonly bar_share_of_net_worth: PercentFigure;
  readonly line_share_of_net_worth: PercentFigure;
}

const decimal = (value: string) => {
  const parsed = parseDecimalString(value);
  if (parsed === null) throw new Error('A chart sample needs a canonical decimal');
  return parsed;
};

const SAMPLE_REASONS = {
  estimated: [
    { code: 'reconstructed_history', wallet: 'sample-wallet', until: '2026-10-03T00:00:00Z' },
  ],
  partial: [{ code: 'unpriced_leg', position: 'sample-position' }],
} as const satisfies Record<'estimated' | 'partial', readonly FigureReason[]>;

const figure = (
  amount: string,
  exactness: 'complete' | 'estimated' | 'partial' = 'complete',
): Figure => {
  const value = { amount: decimal(amount), unit: 'sol' as const };
  if (exactness === 'complete') return { exactness, value };
  return {
    exactness,
    value,
    reasons: [...SAMPLE_REASONS[exactness]],
  };
};

const percent = (
  amount: string,
  exactness: 'complete' | 'estimated' | 'partial' = 'complete',
): PercentFigure => {
  const value = decimal(amount);
  return exactness === 'complete'
    ? { exactness, value }
    : { exactness, value, reasons: [...SAMPLE_REASONS[exactness]] };
};
const unavailable: Figure = { exactness: 'unavailable', reasons: [{ code: 'zero_denominator' }] };
const unavailablePercent: PercentFigure = {
  exactness: 'unavailable',
  reasons: [{ code: 'zero_denominator' }],
};

export const CHART_SAMPLES: readonly ChartSample[] = [
  {
    start: '2026-10-01T00:00:00Z',
    bar: figure('0.4215'),
    line: figure('0.4215'),
    bar_share_of_net_worth: percent('0.7'),
    line_share_of_net_worth: percent('0.7'),
  },
  {
    start: '2026-10-02T00:00:00Z',
    bar: figure('-0.21'),
    line: figure('0.2115'),
    bar_share_of_net_worth: percent('-0.35'),
    line_share_of_net_worth: percent('0.35'),
  },
  {
    start: '2026-10-03T00:00:00Z',
    bar: figure('0.19', 'estimated'),
    line: figure('0.4015', 'estimated'),
    bar_share_of_net_worth: percent('0.32', 'estimated'),
    line_share_of_net_worth: percent('0.67', 'estimated'),
  },
  {
    start: '2026-10-04T00:00:00Z',
    bar: figure('0'),
    line: figure('0.4015'),
    bar_share_of_net_worth: percent('0'),
    line_share_of_net_worth: percent('0.67'),
  },
  {
    start: '2026-10-05T00:00:00Z',
    bar: unavailable,
    line: unavailable,
    bar_share_of_net_worth: unavailablePercent,
    line_share_of_net_worth: unavailablePercent,
  },
  {
    start: '2026-10-06T00:00:00Z',
    bar: figure('0.2812', 'partial'),
    line: figure('0.6827', 'partial'),
    bar_share_of_net_worth: percent('0.47', 'partial'),
    line_share_of_net_worth: percent('1.14', 'partial'),
  },
  {
    start: '2026-10-07T00:00:00Z',
    bar: figure('0.15'),
    line: figure('0.8327'),
    bar_share_of_net_worth: percent('0.25'),
    line_share_of_net_worth: percent('1.39'),
  },
];
