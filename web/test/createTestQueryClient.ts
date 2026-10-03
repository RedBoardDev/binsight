import { QueryClient } from '@tanstack/react-query';

// Without retries, a test that expects a failed request sees it at once instead of after the
// production back-off.
export const createTestQueryClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
