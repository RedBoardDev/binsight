import type { ApiSchema } from '@app/lib/api/apiSchema';

export const statsSeriesFixture = (
  currency: ApiSchema<'Currency'> = 'sol',
): ApiSchema<'StatsSeries'> => ({
  series: 'real_pnl',
  bucket: 'day',
  window: {
    period: '1m',
    start: '2026-09-29T22:00:00Z',
    end: '2026-10-06T12:00:00Z',
    timezone: 'Europe/Berlin',
  },
  header: { value: { exactness: 'complete', value: { amount: '12.553', unit: currency } } },
  points: [
    {
      start: '2026-09-29T22:00:00Z',
      end: '2026-09-30T22:00:00Z',
      bar: { exactness: 'complete', value: { amount: '1.000499999999999999', unit: currency } },
      bar_share_of_net_worth: { exactness: 'complete', value: '2.41' },
      line: { exactness: 'complete', value: { amount: '1.000499999999999999', unit: currency } },
      line_share_of_net_worth: { exactness: 'complete', value: '20.4' },
    },
    {
      start: '2026-09-30T22:00:00Z',
      end: '2026-10-01T22:00:00Z',
      bar: { exactness: 'complete', value: { amount: '-0.21', unit: currency } },
      bar_share_of_net_worth: { exactness: 'complete', value: '-0.21' },
      line: { exactness: 'complete', value: { amount: '0.790499999999999999', unit: currency } },
      line_share_of_net_worth: { exactness: 'complete', value: '0.79' },
    },
    {
      start: '2026-10-01T22:00:00Z',
      end: '2026-10-02T22:00:00Z',
      bar: { exactness: 'complete', value: { amount: '3.4', unit: currency } },
      bar_share_of_net_worth: { exactness: 'complete', value: '3.4' },
      line: { exactness: 'complete', value: { amount: '4.190499999999999999', unit: currency } },
      line_share_of_net_worth: { exactness: 'complete', value: '4.19' },
    },
    {
      start: '2026-10-02T22:00:00Z',
      end: '2026-10-03T22:00:00Z',
      bar: { exactness: 'complete', value: { amount: '-2', unit: currency } },
      bar_share_of_net_worth: { exactness: 'complete', value: '-2' },
      line: { exactness: 'complete', value: { amount: '2.190499999999999999', unit: currency } },
      line_share_of_net_worth: { exactness: 'complete', value: '2.19' },
    },
    {
      start: '2026-10-03T22:00:00Z',
      end: '2026-10-04T22:00:00Z',
      bar: { exactness: 'complete', value: { amount: '5', unit: currency } },
      bar_share_of_net_worth: { exactness: 'complete', value: '5' },
      line: { exactness: 'complete', value: { amount: '7.190499999999999999', unit: currency } },
      line_share_of_net_worth: { exactness: 'complete', value: '7.19' },
    },
    {
      start: '2026-10-04T22:00:00Z',
      end: '2026-10-05T22:00:00Z',
      bar: { exactness: 'complete', value: { amount: '-1', unit: currency } },
      bar_share_of_net_worth: { exactness: 'complete', value: '-1' },
      line: { exactness: 'complete', value: { amount: '6.190499999999999999', unit: currency } },
      line_share_of_net_worth: { exactness: 'complete', value: '6.19' },
    },
    {
      start: '2026-10-05T22:00:00Z',
      end: '2026-10-06T12:00:00Z',
      bar: { exactness: 'complete', value: { amount: '6.362500000000000001', unit: currency } },
      bar_share_of_net_worth: { exactness: 'complete', value: '6.36' },
      line: { exactness: 'complete', value: { amount: '12.553', unit: currency } },
      line_share_of_net_worth: { exactness: 'complete', value: '20.4' },
    },
  ],
});
