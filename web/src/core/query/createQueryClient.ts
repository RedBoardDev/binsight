import type { EntityName } from '@app/applications/Shared/Domain/entityName';
import { QueryClient } from '@tanstack/react-query';

const MAX_NETWORK_RETRIES = 3;
const FIRST_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 8_000;
const STALE_TIME_MS = 30_000;

// fetch rejects with a TypeError only when no answer came back (offline, server down): that is
// worth retrying. An answer, even an error, is final; retrying a 401 or a 404 changes nothing.
export const shouldRetryQuery = (failureCount: number, error: unknown): boolean =>
  error instanceof TypeError && failureCount < MAX_NETWORK_RETRIES;

export const queryRetryDelay = (failureCount: number): number =>
  Math.min(FIRST_RETRY_DELAY_MS * 2 ** failureCount, MAX_RETRY_DELAY_MS);

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        staleTime: STALE_TIME_MS,
        refetchOnReconnect: true,
      },
      mutations: { retry: 0 },
    },
  });

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: { entities?: readonly EntityName[] };
  }
}
