import { QueryClient, type QueryKey } from '@tanstack/react-query';

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

/**
 * Placeholder for the scope-keyed queries (`[name, scope, …]`): keep the previous key's data on
 * screen while a period / page / filter change loads, but never across scopes. TanStack reports
 * placeholder data as a success, so another wallet's figures would otherwise render as this one's.
 */
export const sameScopePlaceholder =
  (scope: string) =>
  <T>(previous: T | undefined, previousQuery: { queryKey: QueryKey } | undefined): T | undefined =>
    previousQuery?.queryKey[1] === scope ? previous : undefined;
