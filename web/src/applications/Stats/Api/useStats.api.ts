'use client';

import { apiGet } from '@app/applications/Shared/Api/httpClient';
import type { Bucket, NetworthCurve, ProfitBucket, Stats, WalletPnlCurve } from '@binsight/shared';
import { useQuery } from '@tanstack/react-query';

const wallet = (scope: string) => `wallet=${encodeURIComponent(scope)}`;

export function useStats(scope: string, closedVersion: number, since = 0) {
  return useQuery({
    queryKey: ['stats', scope, since, closedVersion],
    queryFn: () => apiGet<Stats>(`stats?${wallet(scope)}${since > 0 ? `&since=${since}` : ''}`),
  });
}

export function useProfitHistory(
  scope: string,
  bucket: Bucket,
  since: number,
  closedVersion: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ['profit-history', scope, bucket, since, closedVersion],
    queryFn: () =>
      apiGet<ProfitBucket[]>(`stats/history?${wallet(scope)}&bucket=${bucket}&since=${since}`),
    enabled,
  });
}

/** The forward-only TRUE Net Worth curve (on-chain wallet total = tvl + idle, sampled over time). */
export function useNetworthCurve(
  scope: string,
  days: number,
  closedVersion: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ['networth-curve', scope, days, closedVersion],
    queryFn: () => apiGet<NetworthCurve>(`networth/curve?${wallet(scope)}&days=${days}`),
    enabled,
  });
}

/** The TRUE wallet PnL curve from on-chain SOL cash-flow — captures rug/slippage losses the
 *  position-level history misses. */
export function useWalletPnlCurve(scope: string, days: number, closedVersion: number) {
  return useQuery({
    queryKey: ['wallet-pnl-curve', scope, days, closedVersion],
    queryFn: () => apiGet<WalletPnlCurve>(`wallet/pnl-curve?${wallet(scope)}&days=${days}`),
  });
}

export const fetchProfitHistory = (scope: string, bucket: Bucket, since: number) =>
  apiGet<ProfitBucket[]>(`stats/history?${wallet(scope)}&bucket=${bucket}&since=${since}`);

export const fetchNetworthCurve = (scope: string, days: number) =>
  apiGet<NetworthCurve>(`networth/curve?${wallet(scope)}&days=${days}`);
