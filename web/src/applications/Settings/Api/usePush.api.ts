'use client';

import { apiGet, apiSend } from '@app/applications/Shared/Api/httpClient';
import { PUSH_READY_TIMEOUT_MS } from '@app/applications/Shared/Domain/timings';

export const fetchVapidKey = (): Promise<{ key: string }> => apiGet('push/vapid-public-key');
export const subscribeToPush = (subscription: unknown): Promise<boolean> =>
  apiSend('push/subscribe', 'POST', subscription);
export const unsubscribeFromPush = (endpoint: string): Promise<boolean> =>
  apiSend('push/unsubscribe', 'POST', { endpoint });
export const sendTestPush = (): Promise<boolean> => apiSend('push/test', 'POST', {});

/** SW registration, or null if none becomes active shortly (dev: the SW is production-only). */
export async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PUSH_READY_TIMEOUT_MS)),
  ]);
}

/**
 * Drop this browser's push subscription — server side first, then the local handle. Resolves false
 * when there is no local subscription (nothing tells the server which endpoint to drop), and throws
 * when the server refuses, so a caller never reports "off" while pushes keep arriving.
 */
export async function dropPushSubscription(): Promise<boolean> {
  const registration = await activeRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  if (!(await unsubscribeFromPush(subscription.endpoint))) throw new Error('unsubscribe refused');
  await subscription.unsubscribe();
  return true;
}
