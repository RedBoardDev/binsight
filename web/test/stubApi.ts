import { vi } from 'vitest';

type Route = `${'GET' | 'POST'} /api/${string}`;

type Reply = (request: Request) => Response | Promise<Response>;

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const errorResponse = (
  status: number,
  code: string,
  headers: Record<string, string> = {},
): Response =>
  jsonResponse(status, { error: { code, message: 'test', request_id: 'test-request' } }, headers);

export const signedInSession = (): Response =>
  jsonResponse(200, { authenticated: true, expires_at: '2026-11-02T12:00:00Z' });

export const signedOutSession = (): Response => errorResponse(401, 'unauthenticated');

// Replaces fetch for one test (Vitest's unstubGlobals restores it): each route answers with its
// reply, any other request gets a JSON 404 like the real server's.
export const stubApi = (routes: Partial<Record<Route, Reply>>): ReturnType<typeof vi.fn> => {
  const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    const route = `${request.method} ${new URL(request.url).pathname}`;
    const reply = Object.entries(routes).find(([key]) => key === route)?.[1];
    return reply === undefined ? errorResponse(404, 'not_found') : reply(request);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
};
