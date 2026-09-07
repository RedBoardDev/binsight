import { QueryClient } from '@tanstack/react-query';

/**
 * The live WebSocket feed pushes portfolio state, so REST reads only need to cover what the socket
 * does not carry (history, stats, curves). `staleTime` is therefore generous and refetch-on-focus is
 * off — a window refocus must not restampede the API for numbers the socket already keeps current.
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
        placeholderData: <T>(previous: T) => previous,
      },
    },
  });
