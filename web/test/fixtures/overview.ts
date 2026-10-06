import type { ApiSchema } from '@app/lib/api/apiSchema';

export const completeOverviewAmount = (amount: string): ApiSchema<'Figure'> => ({
  exactness: 'complete',
  value: { amount, unit: 'sol' },
});
export const completeOverviewPercent = (value: string): ApiSchema<'PercentFigure'> => ({
  exactness: 'complete',
  value,
});

export const overviewFixture = (): ApiSchema<'Overview'> => ({
  wallet: null,
  freshness: { as_of: '2026-10-06T12:00:00Z', state: 'live', lag_seconds: 0 },
  sync: { state: 'live', lagging: [], importing: [] },
  today: {
    window: {
      start: '2026-10-06T00:00:00Z',
      end: '2026-10-06T12:00:00Z',
      period: 'today',
      day: null,
      timezone: 'UTC',
    },
    totals: {
      count: 5,
      wins: 3,
      losses: 2,
      flat: 0,
      unclassified_count: 0,
      win_rate: completeOverviewPercent('60'),
      pnl: completeOverviewAmount('1.000499999999999999999'),
      pnl_pct: completeOverviewPercent('2.56'),
      fees: completeOverviewAmount('0.02'),
      rewards: completeOverviewAmount('0'),
      invested: completeOverviewAmount('39.0820312499999999999609375'),
      withdrawn: completeOverviewAmount('40.0625312499999999999599375'),
      average_held_seconds: 3600,
      median_held_seconds: 3600,
    },
  },
  net_worth: {
    total: completeOverviewAmount('100.123456789'),
    lp: completeOverviewAmount('80'),
    idle: completeOverviewAmount('15.123456789'),
    unclaimed_fees: completeOverviewAmount('4'),
    recoverable_rent: completeOverviewAmount('1'),
    unpriced: [],
  },
  open: {
    count: 8,
    out_of_range_count: 2,
    pnl: completeOverviewAmount('1.336'),
    pnl_pct: completeOverviewPercent('2.5'),
    unclaimed_fees: completeOverviewAmount('4'),
    unclaimed_position_count: 4,
  },
  gain: {
    window: {
      start: '2026-09-06T12:00:00Z',
      end: '2026-10-06T12:00:00Z',
      period: '1m',
      day: null,
      timezone: 'UTC',
    },
    value: completeOverviewAmount('12.553'),
    pct: completeOverviewPercent('20.4'),
  },
  watch: [],
});
