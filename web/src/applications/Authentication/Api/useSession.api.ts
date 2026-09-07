'use client';

import { authApi } from '@app/applications/Authentication/Api/auth.api';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

/** Sign out and land on the login screen. The source of truth is the httpOnly cookie, cleared by the
 *  auth route — nothing client-side needs to hold a session flag. */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  return useCallback(async () => {
    await authApi.logout();
    router.replace('/login');
  }, [router]);
}
