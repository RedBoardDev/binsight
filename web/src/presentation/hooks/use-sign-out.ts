'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { useIdentity } from '@/application/stores/identity-store';

export const LOGIN_ROUTE = '/login';
/** Query param the login screen reads to show the "session expired" message (SPEC UX #84). */
export const SESSION_EXPIRED_PARAM = 'expired';

/**
 * The one sign-out path (desktop header, mobile settings drawer, expired-session handling):
 * Privy logout (sessions are 100% Privy) + session-scoped client state cleared + redirect to
 * login. Pass `expired: true` when the session died under the user so the login screen says so.
 */
export function useSignOut(): (opts?: { expired?: boolean }) => Promise<void> {
  const { logout } = usePrivy();
  const router = useRouter();
  const resetIdentity = useIdentity((s) => s.reset);

  return useCallback(
    async ({ expired = false }: { expired?: boolean } = {}) => {
      await logout();
      // Drop cached per-account state so a next login on this device never sees the previous
      // account (portfolio/wallet stores already tear down on dashboard unmount).
      resetIdentity();
      router.replace(expired ? `${LOGIN_ROUTE}?${SESSION_EXPIRED_PARAM}=1` : LOGIN_ROUTE);
    },
    [logout, resetIdentity, router],
  );
}
