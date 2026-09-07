'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker (offline shell + Web Push). Production-only: in `next dev` a service
 * worker would cache HMR chunks and fight hot reload. `updateViaCache: 'none'` keeps the SW script
 * itself from ever going stale.
 */
export const ServiceWorkerRegistrar = () => {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      /* registration failure is non-fatal — the app works without the SW */
    });
  }, []);

  return null;
};
