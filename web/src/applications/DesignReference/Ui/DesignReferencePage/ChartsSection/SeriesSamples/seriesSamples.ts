import type { PulsePoint } from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import type { CreditDay } from '@app/applications/Shared/Chart/Domain/stackedBars';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Figure, PercentFigure } from '@app/applications/Shared/Figure/Domain/figure';

const decimal = (amount: string) => {
  const value = parseDecimalString(amount);
  if (value === null) throw new Error('A sample needs a canonical server amount');
  return value;
};

const money = (amount: string): Extract<Figure, { exactness: 'complete' }> => ({
  exactness: 'complete',
  value: { amount: decimal(amount), unit: 'sol' },
});

export const NET_WORTH_SAMPLES: readonly PulsePoint[] = [
  { start: '2026-10-17T00:00:00Z', line: money('100') },
  { start: '2026-10-18T00:00:00Z', line: money('103') },
  { start: '2026-10-19T00:00:00Z', line: { ...money('101'), exactness: 'estimated', reasons: [] } },
  { start: '2026-10-20T00:00:00Z', line: { exactness: 'unavailable', reasons: [] } },
  { start: '2026-10-21T00:00:00Z', line: { ...money('107'), exactness: 'partial', reasons: [] } },
  { start: '2026-10-22T00:00:00Z', line: money('110') },
];
export const NET_WORTH_CHANGE: PercentFigure = { exactness: 'complete', value: decimal('10') };
export const CREDIT_CYCLE_SAMPLE = { start: '2026-10-17T00:00:00Z', end: '2026-11-17T00:00:00Z' };
export const CREDIT_SAMPLES: readonly CreditDay[] = [
  { day: '2026-10-17', used: 230, segments: [100, 80, 30, 20] },
  { day: '2026-10-18', used: 680, segments: [300, 200, 130, 50] },
  { day: '2026-10-19', used: 450, segments: [200, 100, 100, 50] },
  { day: '2026-10-20', used: 520, segments: [240, 180, 60, 40] },
  { day: '2026-10-21', used: 410, segments: [200, 100, 80, 30] },
  { day: '2026-10-22', used: 700, segments: [300, 250, 100, 50] },
  { day: '2026-10-23', used: 560, segments: [250, 180, 90, 40] },
  { day: '2026-10-31', used: 800, segments: [400, 200, 130, 70] },
  { day: '2026-11-01', used: 620, segments: [300, 180, 100, 40] },
  { day: '2026-11-02', used: 320, segments: [150, 100, 50, 20] },
];
