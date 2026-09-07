'use client';

import { apiGet } from '@app/applications/Shared/Api/httpClient';
import { useQuery } from '@tanstack/react-query';

/** SOL spot price in USD for the display-currency toggle. The rate barely moves, so one poll a
 *  minute is plenty and every reader shares the single cache entry. */
export function useSolUsd(): number | null {
  const { data } = useQuery({
    queryKey: ['sol-usd'],
    queryFn: () => apiGet<{ price: number | null }>('sol-usd'),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
  const price = data?.price;
  return price != null && Number.isFinite(price) && price > 0 ? price : null;
}
