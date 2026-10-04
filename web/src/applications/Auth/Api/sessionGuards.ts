import { sessionQuery } from '@app/applications/Auth/Api/sessionQuery';
import { safeRedirect } from '@app/applications/Auth/Domain/safeRedirect';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';

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
