'use client';

import type { RpcTelemetry } from '@app/applications/Admin/Domain/rpcTelemetry';
import { apiGet, apiSend } from '@app/applications/Shared/Api/httpClient';
import type { AccessEntry, WalletOverview } from '@binsight/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** Unified access list: invited (whitelisted) plus joined (registered) accounts. Owner only — the
 *  backend re-checks `isOwner` on every call. */
export function useAccessEntries() {
  return useQuery({
    queryKey: ['admin-access'],
    queryFn: () => apiGet<AccessEntry[]>('admin/access'),
  });
}

export function useAdminWallets() {
  return useQuery({
    queryKey: ['admin-wallets'],
    queryFn: () => apiGet<WalletOverview[]>('admin/wallets'),
  });
}

export function useRpcTelemetry(refetchInterval: number | false) {
  return useQuery({
    queryKey: ['admin-rpc'],
    queryFn: () => apiGet<RpcTelemetry>('debug/rpc'),
    refetchInterval,
  });
}

export function useAccessMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-access'] });

  const invite = useMutation({
    mutationFn: ({ address, note }: { address: string; note: string }) =>
      apiSend('admin/access', 'POST', { address, note }),
    onSuccess: invalidate,
  });

  const revoke = useMutation({
    mutationFn: (address: string) =>
      apiSend(`admin/access/${encodeURIComponent(address)}`, 'DELETE'),
    onSuccess: invalidate,
  });

  return { invite, revoke };
}
