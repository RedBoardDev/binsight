import type { AppRouter } from '@app/core/router';
import type { QueryClient } from '@tanstack/react-query';

interface SignInRedirect {
  readonly router: AppRouter;
  readonly queryClient: QueryClient;
}

// Called when the API answers 401: the session expired or its cookie was deleted.
export const redirectToSignIn = ({ router, queryClient }: SignInRedirect): void => {
  const { pathname, href } = router.state.location;
  // On the login page already: navigating there again, with itself as the destination, would loop.
  if (pathname === '/login') {
    return;
  }
  // Cleared first: the login route would otherwise find the cached session and send the owner
  // straight back here.
  queryClient.clear();
  void router.navigate({ to: '/login', search: { redirect: href } });
};
