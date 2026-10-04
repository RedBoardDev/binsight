import { logout } from '@app/applications/Auth/Api/logout';
import { errorResponse, stubApi } from '@test/stubApi';
import { describe, expect, it, vi } from 'vitest';

describe('logout', () => {
  it('succeeds when the server deletes the cookie', async () => {
    stubApi({ 'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }) });

    expect(await logout()).toEqual({ status: 'success' });
  });

  it('reports a refused request by its error code', async () => {
    stubApi({ 'POST /api/v1/auth/logout': () => errorResponse(403, 'forbidden_cross_origin') });

    expect(await logout()).toEqual({
      status: 'error',
      formError: { kind: 'api', code: 'forbidden_cross_origin' },
    });
  });

  it('reports an unreachable server without throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));

    expect(await logout()).toEqual({ status: 'error', formError: { kind: 'network' } });
  });

  it('reports an unexpected failure without throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('unexpected')));

    expect(await logout()).toEqual({ status: 'error', formError: { kind: 'api', code: null } });
  });
});
