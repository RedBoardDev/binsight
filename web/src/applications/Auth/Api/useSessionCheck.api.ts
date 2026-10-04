import { sessionQuery } from '@app/applications/Auth/Api/sessionQuery';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';

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
