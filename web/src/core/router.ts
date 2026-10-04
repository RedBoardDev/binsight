import { reducedMotionStore } from '@app/applications/Shared/Motion/Ui/reducedMotionStore';
import { NotFoundScreen } from '@app/core/NotFoundScreen';
import { ShellErrorScreen } from '@app/core/ShellErrorScreen';
import { routeTree } from '@app/routeTree.gen';
import type { QueryClient } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';

interface AppRouterOptions {
  readonly queryClient: QueryClient;
  readonly history?: RouterHistory;
}

const buildRouter = ({ queryClient, history }: AppRouterOptions) =>
  createRouter({
    routeTree,
    context: { queryClient },
    ...(history === undefined ? {} : { history }),
    defaultPreload: 'intent',
    // A change of search params alone (a filter, an open drawer) is not a new page: no cross-fade.
    defaultViewTransition: {
      types: ({ pathChanged }) =>
        pathChanged && !reducedMotionStore.isReduced() ? ['page'] : false,
    },
    // TanStack Query owns the cache: the router hands every preload to it, and the query's own
    // staleTime decides whether to fetch.
    defaultPreloadStaleTime: 0,
    // Set on every route, so a failing page renders inside its parent's layout: the menu stays.
    defaultErrorComponent: ShellErrorScreen,
    defaultNotFoundComponent: NotFoundScreen,
  });

export type AppRouter = ReturnType<typeof buildRouter>;

export const createAppRouter = (options: AppRouterOptions): AppRouter => buildRouter(options);

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
