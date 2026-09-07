'use client';

import { apiSend } from '@app/applications/Shared/Api/httpClient';

/** Force the engine to re-poll every watched wallet now, ahead of its own schedule. */
export const forceRefresh = (): Promise<boolean> => apiSend('refresh', 'POST');
