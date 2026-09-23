'use client';

import { authApi } from '@app/applications/Authentication/Api/auth.api';
import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { dropPushSubscription } from '@app/applications/Settings/Api/usePush.api';
import { forgetSavedScope } from '@app/core/Layout/UrlState';
import { useUi } from '@app/core/stores/uiStore';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Wipe everything client-side that belongs to an account: the query cache (its keys carry no user
 * dimension), the live feed, the transient UI and the remembered scope. Run on sign-out AND on
 * sign-in, so the next account never sees a frame of the previous one's data.
 */
export function useResetSession(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    usePortfolioFeed.getState().stop();
    usePortfolioFeed.setState(usePortfolioFeed.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    forgetSavedScope();
    queryClient.clear();
  }, [queryClient]);
}

/** Sign out and land on the login screen. The source of truth is the httpOnly cookie, cleared by the
 *  auth route — nothing client-side needs to hold a session flag, but the cache must go with it. */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  const resetSession = useResetSession();
  return useCallback(async () => {
    // Best-effort, and first: the unsubscribe call still needs the session. Only when a service
    // worker controls the page (no SW in dev → no subscription, and no wait for one).
    if (navigator.serviceWorker?.controller) await dropPushSubscription().catch(() => {});
    await authApi.logout();
    resetSession();
    router.replace('/login');
  }, [router, resetSession]);
}
