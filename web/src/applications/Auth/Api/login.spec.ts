import { login } from '@app/applications/Auth/Api/login';
import { errorResponse, jsonResponse, stubApi } from '@test/stubApi';
import { describe, expect, it, vi } from 'vitest';

const SESSION = { authenticated: true, expires_at: '2026-11-02T12:00:00Z' };

describe('login', () => {
  it('returns the session when the password is right', async () => {
    const fetchStub = stubApi({ 'POST /api/v1/auth/login': () => jsonResponse(200, SESSION) });

    expect(await login({ password: 'right password' })).toEqual({
      status: 'success',
      session: SESSION,
    });
    const request: unknown = fetchStub.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    if (request instanceof Request) {
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(await request.json()).toEqual({ password: 'right password' });
    }
  });

  it('reports a wrong password on the password field', async () => {
    stubApi({ 'POST /api/v1/auth/login': () => errorResponse(401, 'invalid_credentials') });

    expect(await login({ password: 'wrong' })).toEqual({
      status: 'error',
      fieldErrors: { password: 'invalid_credentials' },
    });
  });

  it('reports the wait after too many failed attempts', async () => {
    stubApi({
      'POST /api/v1/auth/login': () =>
        errorResponse(429, 'too_many_attempts', { 'retry-after': '42' }),
    });

    expect(await login({ password: 'wrong' })).toEqual({
      status: 'error',
      formError: { kind: 'too_many_attempts', retryAfterSeconds: 42 },
    });
  });

  it('reports an unreachable server without throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));

    expect(await login({ password: 'any' })).toEqual({
      status: 'error',
      formError: { kind: 'network' },
    });
  });

  it('reports an unexpected failure without throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('unexpected')));

    expect(await login({ password: 'any' })).toEqual({
      status: 'error',
      formError: { kind: 'api', code: null },
    });
  });

  it('reports any other answer by its error code', async () => {
    stubApi({ 'POST /api/v1/auth/login': () => errorResponse(403, 'forbidden_cross_origin') });

    expect(await login({ password: 'any' })).toEqual({
      status: 'error',
      formError: { kind: 'api', code: 'forbidden_cross_origin' },
    });
  });
});
