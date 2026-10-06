import { getOverview } from '@app/applications/Overview/Api/getOverview';
import { overviewQuery } from '@app/applications/Overview/Api/overviewQuery';
import { ApiError } from '@app/lib/api/apiError';
import { createTestQueryClient } from '@test/createTestQueryClient';
import { overviewFixture } from '@test/fixtures/overview';
import { errorResponse, jsonResponse, stubApi } from '@test/stubApi';
import { describe, expect, it } from 'vitest';

describe('overview reads', () => {
  it('sends wallet period and currency without altering the original decimal strings', async () => {
    const fixture = overviewFixture();
    const fetchStub = stubApi({ 'GET /api/v1/overview': () => jsonResponse(200, fixture) });
    expect(await getOverview({ wallet: 'all', period: '1m', currency: 'sol' })).toEqual(fixture);
    const request: unknown = fetchStub.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    if (request instanceof Request) {
      const url = new URL(request.url);
      expect(url.searchParams.get('wallet')).toBe('all');
      expect(url.searchParams.get('period')).toBe('1m');
      expect(url.searchParams.get('currency')).toBe('sol');
    }
  });

  it('reports an unavailable read without turning it into an empty overview', async () => {
    stubApi({ 'GET /api/v1/overview': () => errorResponse(503, 'data_not_ready') });
    await expect(
      getOverview({ wallet: 'all', period: '1m', currency: 'sol' }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('preserves unknown fee presence and a proved zero without altering other figures', async () => {
    for (const count of [null, 0]) {
      const fixture = overviewFixture();
      fixture.open.unclaimed_position_count = count;
      stubApi({ 'GET /api/v1/overview': () => jsonResponse(200, fixture) });
      const overview = await getOverview({ wallet: 'all', period: '1m', currency: 'sol' });
      expect(overview.open.unclaimed_position_count).toBe(count);
      expect(overview).toEqual(fixture);
    }
  });

  it('does not reuse an integer-count v1 cache entry for a nullable v2 response', async () => {
    const request = { wallet: 'all', period: '1m' as const, currency: 'sol' as const };
    const legacy = overviewFixture();
    const current = overviewFixture();
    current.open.unclaimed_position_count = null;
    const fetchStub = stubApi({ 'GET /api/v1/overview': () => jsonResponse(200, current) });
    const client = createTestQueryClient();
    const legacyKey = ['Overview', 'get', request];
    client.setQueryData(legacyKey, legacy);
    expect(await client.fetchQuery(overviewQuery(request))).toEqual(current);
    expect(client.getQueryData(legacyKey)).toEqual(legacy);
    expect(fetchStub).toHaveBeenCalledOnce();
    client.clear();
  });

  it('separates wallet period and currency in the cache and names the invalidation entity', () => {
    const request = { wallet: 'all', period: '1m' as const, currency: 'sol' as const };
    const query = overviewQuery(request);
    expect(query.meta?.entities).toEqual(['Overview']);
    expect(query.queryKey).not.toEqual(
      overviewQuery({ ...request, wallet: 'test-wallet' }).queryKey,
    );
    expect(query.queryKey).not.toEqual(overviewQuery({ ...request, period: '3m' }).queryKey);
    expect(query.queryKey).not.toEqual(overviewQuery({ ...request, currency: 'usd' }).queryKey);
  });
});
