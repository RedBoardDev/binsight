import type { paths } from '@app/lib/api/generated/openapi';
import createClient from 'openapi-fetch';

export const apiClient = createClient<paths>({
  baseUrl: window.location.origin,
  // Looked up on every call rather than captured once: openapi-fetch would otherwise keep the
  // fetch that existed when this module loaded, and a test that stubs fetch would hit the network.
  fetch: (request) => globalThis.fetch(request),
});
