'use client';

import { apiGet, apiGetBlob } from '@app/applications/Shared/Api/httpClient';
import { sameScopePlaceholder } from '@app/applications/Shared/Api/queryClient';
import type { Candle, ClosedPosition, PositionBins, PositionHistory } from '@binsight/shared';
import { useQuery } from '@tanstack/react-query';

export interface ClosedPositionsQuery {
  q: string;
  sort: 'recent' | 'pnl' | 'fees' | 'duration';
  dir: 'asc' | 'desc';
  result: 'all' | 'win' | 'loss';
}

interface ClosedPositionsPage {
  rows: ClosedPosition[];
  total: number;
}

const closedParams = (scope: string, query: ClosedPositionsQuery): URLSearchParams => {
  const params = new URLSearchParams({ wallet: scope, sort: query.sort, dir: query.dir });
  if (query.q) params.set('q', query.q);
  if (query.result !== 'all') params.set('result', query.result);
  return params;
};

export function useClosedPositions(
  scope: string,
  page: number,
  pageSize: number,
  query: ClosedPositionsQuery,
  closedVersion: number,
) {
  return useQuery({
    queryKey: ['closed-positions', scope, page, pageSize, query, closedVersion],
    queryFn: () => {
      const params = closedParams(scope, query);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      return apiGet<ClosedPositionsPage>(`positions/closed?${params.toString()}`);
    },
    placeholderData: sameScopePlaceholder(scope),
  });
}

export function usePositionBins(address: string, enabled: boolean) {
  return useQuery({
    queryKey: ['position-bins', address],
    queryFn: () => apiGet<PositionBins>(`positions/${encodeURIComponent(address)}/bins`),
    enabled,
  });
}

export function usePositionHistory(address: string) {
  return useQuery({
    queryKey: ['position-history', address],
    queryFn: () => apiGet<PositionHistory>(`positions/${encodeURIComponent(address)}/history`),
  });
}

export function usePositionCandles(pool: string, timeframe: string) {
  return useQuery({
    queryKey: ['position-candles', pool, timeframe],
    queryFn: () =>
      apiGet<{ candles: Candle[] }>(
        `pools/${encodeURIComponent(pool)}/ohlcv?tf=${encodeURIComponent(timeframe)}`,
      ),
  });
}

export const fetchClosedPosition = (address: string): Promise<{ closed: ClosedPosition | null }> =>
  apiGet(`positions/${encodeURIComponent(address)}`);

export const fetchPositionCard = (address: string, signal?: AbortSignal): Promise<Blob> =>
  apiGetBlob(`positions/${encodeURIComponent(address)}/card.png`, 'image/png', signal);

/** Cookie-authed CSV download of the current filter, so a plain anchor carries the session. */
export const closedPositionsCsvHref = (scope: string, query: ClosedPositionsQuery): string =>
  `/api/positions/closed.csv?${closedParams(scope, query).toString()}`;
