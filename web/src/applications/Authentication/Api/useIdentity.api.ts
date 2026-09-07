'use client';

import { apiGet } from '@app/applications/Shared/Api/httpClient';
import { useQuery } from '@tanstack/react-query';

export interface AccountIdentity {
  address: string;
  isOwner: boolean;
}

/** The signed-in account (address + owner flag) — drives the owner-only Admin entry. */
export function useIdentity() {
  return useQuery({
    queryKey: ['identity'],
    queryFn: () => apiGet<AccountIdentity>('auth/me'),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
