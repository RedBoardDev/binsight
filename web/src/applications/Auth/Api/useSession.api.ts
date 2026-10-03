import { sessionQuery } from '@app/applications/Auth/Api/sessionQuery';
import { safeRedirect } from '@app/applications/Auth/Domain/safeRedirect';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { redirect, useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';

export const requireSession = async (
  queryClient: QueryClient,
  currentHref: string,
): Promise<void> => {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (session === null) {
    throw redirect({ to: '/login', search: { redirect: currentHref } });
  }
};

export const leaveLoginWhenSignedIn = async (
  queryClient: QueryClient,
  destination: string | undefined,
): Promise<void> => {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (session !== null) {
    throw redirect({ href: safeRedirect(destination) });
  }
};

// For a stream the server refused: if the session is gone, the guard sends the owner to the
// login page with the current page as destination.
export const useSessionCheck = (): (() => Promise<void>) => {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useCallback(async () => {
    const session = await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    if (session === null) {
      await router.invalidate();
    }
  }, [queryClient, router]);
};
