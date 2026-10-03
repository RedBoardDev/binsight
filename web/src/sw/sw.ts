import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  type PrecacheEntry,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NAVIGATION_DENYLIST } from './navigationDenylist';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

const isSkipWaitingMessage = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && 'type' in data && data.type === 'SKIP_WAITING';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Never register a route that matches /api/, not even NetworkOnly: the SSE stream would then
// flow through the worker, which buffers it and drops it when the browser stops the worker.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [...NAVIGATION_DENYLIST],
  }),
);

// The new version waits until the owner accepts the update prompt, which sends this message.
self.addEventListener('message', (event) => {
  if (isSkipWaitingMessage(event.data)) {
    void self.skipWaiting();
  }
});

clientsClaim();
