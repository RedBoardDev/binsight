import { vi } from 'vitest';
import { activeSession } from './fixtures/session';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// "GET /api/v1/positions" answers whatever the query; "GET /api/v1/positions?wallet=all" answers
// that exact query only, and wins over the former.
type Route = `${HttpMethod} /api/${string}`;

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

export const noContent = (): Response => new Response(null, { status: 204 });

export const signedInSession = (): Response => jsonResponse(200, activeSession());

export const signedOutSession = (): Response => errorResponse(401, 'unauthenticated');

const findReply = (
  routes: Partial<Record<Route, Reply>>,
  method: string,
  url: URL,
): Reply | undefined => {
  const replies = new Map(Object.entries(routes));
  return (
    replies.get(`${method} ${url.pathname}${url.search}`) ??
    replies.get(`${method} ${url.pathname}`)
  );
};

// Replaces fetch for one test (Vitest's unstubGlobals restores it): each route answers with its
// reply, any other request gets a JSON 404 like the real server's.
export const stubApi = (routes: Partial<Record<Route, Reply>>): ReturnType<typeof vi.fn> => {
  const fetchStub = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const reply = findReply(routes, request.method, new URL(request.url));
    return reply === undefined ? errorResponse(404, 'not_found') : reply(request);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
};
