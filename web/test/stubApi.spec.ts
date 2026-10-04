import { describe, expect, it } from 'vitest';
import { jsonResponse, noContent, stubApi } from './stubApi';

describe('stubApi', () => {
  it('answers every method of a route', async () => {
    stubApi({
      'PUT /api/v1/settings': () => jsonResponse(200, { saved: true }),
      'PATCH /api/v1/wallets/a': () => jsonResponse(200, { label: 'Main' }),
      'DELETE /api/v1/wallets/a': noContent,
    });

    expect((await fetch('http://app/api/v1/settings', { method: 'PUT' })).status).toBe(200);
    expect((await fetch('http://app/api/v1/wallets/a', { method: 'PATCH' })).status).toBe(200);
    expect((await fetch('http://app/api/v1/wallets/a', { method: 'DELETE' })).status).toBe(204);
  });

  it('prefers the route of the exact query, then the route of the path', async () => {
    stubApi({
      'GET /api/v1/positions': () => jsonResponse(200, { which: 'any' }),
      'GET /api/v1/positions?wallet=all': () => jsonResponse(200, { which: 'all' }),
    });

    const all = await (await fetch('http://app/api/v1/positions?wallet=all')).json();
    const other = await (await fetch('http://app/api/v1/positions?wallet=b')).json();
    expect([all, other]).toEqual([{ which: 'all' }, { which: 'any' }]);
  });

  it('answers a JSON 404 to anything else, like the server', async () => {
    stubApi({});

    const response = await fetch('http://app/api/v1/nothing');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
