'use client';

import { apiGet, apiSend } from '@app/applications/Shared/Api/httpClient';

export const fetchVapidKey = (): Promise<{ key: string }> => apiGet('push/vapid-public-key');
export const subscribeToPush = (subscription: unknown): Promise<boolean> =>
  apiSend('push/subscribe', 'POST', subscription);
export const unsubscribeFromPush = (endpoint: string): Promise<boolean> =>
  apiSend('push/unsubscribe', 'POST', { endpoint });
export const sendTestPush = (): Promise<boolean> => apiSend('push/test', 'POST', {});
