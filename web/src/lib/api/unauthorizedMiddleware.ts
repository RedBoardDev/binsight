import type { Middleware } from 'openapi-fetch';

// Login answers 401 to a wrong password and the session endpoint answers 401 when signed out:
// both are expected answers. Treating them as an expired session would send the login page to
// itself in a loop.
const SESSION_PATHS: ReadonlySet<string> = new Set(['/api/v1/auth/login', '/api/v1/auth/session']);

export const createUnauthorizedMiddleware = (onUnauthorized: () => void): Middleware => ({
  onResponse: ({ request, response }) => {
    if (response.status === 401 && !SESSION_PATHS.has(new URL(request.url).pathname)) {
      onUnauthorized();
    }
    return undefined;
  },
});
