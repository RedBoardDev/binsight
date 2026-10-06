import { getStatsSeries } from '@app/applications/Stats/Api/getStatsSeries';
import { statsSeriesQuery } from '@app/applications/Stats/Api/statsSeriesQuery';
import { ApiError } from '@app/lib/api/apiError';
import { statsSeriesFixture } from '@test/fixtures/statsSeries';
import { errorResponse, jsonResponse, stubApi } from '@test/stubApi';
import { describe, expect, it } from 'vitest';

const request = {
  wallet: 'all',
  period: '1m',
  currency: 'sol',
  series: 'real_pnl',
  bucket: 'day',
} as const;

describe('stats series reads', () => {
  it('requests daily real pnl and retains the four original wire readings', async () => {
    const fixture = statsSeriesFixture();
    const fetchStub = stubApi({ 'GET /api/v1/stats/series': () => jsonResponse(200, fixture) });
    expect(await getStatsSeries(request)).toEqual(fixture);
    const fetched: unknown = fetchStub.mock.calls[0]?.[0];
    expect(fetched).toBeInstanceOf(Request);
    if (fetched instanceof Request) {
      expect(Object.fromEntries(new URL(fetched.url).searchParams)).toEqual(request);
    }
  });

  it('exposes a bucket-limit error without substituting another series', async () => {
    const fetchStub = stubApi({
      'GET /api/v1/stats/series': () => errorResponse(400, 'invalid_request'),
    });
    await expect(getStatsSeries({ ...request, period: 'all' })).rejects.toBeInstanceOf(ApiError);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('isolates every server parameter in the cache and declares stats invalidation', () => {
    const query = statsSeriesQuery(request);
    expect(query.meta?.entities).toEqual(['Stats']);
    for (const changed of [
      { ...request, wallet: 'test-wallet' },
      { ...request, period: '7d' as const },
      { ...request, currency: 'usd' as const },
      { ...request, series: 'net_worth' as const },
      { ...request, bucket: 'week' as const },
    ])
      expect(statsSeriesQuery(changed).queryKey).not.toEqual(query.queryKey);
  });
});
