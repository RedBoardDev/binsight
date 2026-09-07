'use client';

import { apiGet, apiSend } from '@app/applications/Shared/Api/httpClient';
import type { Wallet } from '@binsight/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * The watchlist plus each wallet's onboarding status (`ready` / `indexedTxs`), shared by the scope
 * selector, the settings panel and the indexing banner. While any wallet is still backfilling its
 * history the query self-polls, so the "indexing…" state clears on its own — no socket message needed.
 */
export function useWallets() {
  return useQuery({
    queryKey: ['wallets'],
    queryFn: () => apiGet<Wallet[]>('wallets'),
    refetchInterval: (query) => (query.state.data?.some((w) => w.ready === false) ? 3_000 : false),
  });
}

export function useWalletMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['wallets'] });

  const add = useMutation({
    mutationFn: ({ address, label }: { address: string; label: string }) =>
      apiSend('wallets', 'POST', { address, label }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (address: string) => apiSend(`wallets/${encodeURIComponent(address)}`, 'DELETE'),
    onSuccess: invalidate,
  });

  return { add, remove };
}
