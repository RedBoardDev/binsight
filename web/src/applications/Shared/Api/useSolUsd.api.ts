'use client';

import { ApiError, apiGet } from '@app/applications/Shared/Api/httpClient';
import { useQuery } from '@tanstack/react-query';

const isRate = (price: number | null | undefined): price is number =>
  price != null && Number.isFinite(price) && price > 0;

/** SOL spot price in USD for the display-currency toggle. The rate barely moves, so one poll a
 *  minute is plenty and every reader shares the single cache entry. A missing price fails the poll
 *  rather than resolving to null, so the last good rate stays — a transient gap in the upstream
 *  quote must not flip every amount on screen back out of USD. */
export function useSolUsd(): number | null {
  const { data } = useQuery({
    queryKey: ['sol-usd'],
    queryFn: async () => {
      const { price } = await apiGet<{ price: number | null }>('sol-usd');
      if (!isRate(price)) throw new ApiError('no SOL/USD price');
      return price;
    },
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
  return data ?? null;
}
