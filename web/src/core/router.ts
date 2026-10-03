import { NotFoundScreen } from '@app/core/NotFoundScreen';
import { ShellErrorScreen } from '@app/core/ShellErrorScreen';
import { routeTree } from '@app/routeTree.gen';
import { createRouter, type RouterHistory } from '@tanstack/react-router';

const buildRouter = (history: RouterHistory | undefined) =>
  createRouter({
    routeTree,
    ...(history === undefined ? {} : { history }),
    defaultPreload: 'intent',
    // Set on every route, so a failing page renders inside its parent's layout: the menu stays.
    defaultErrorComponent: ShellErrorScreen,
    defaultNotFoundComponent: NotFoundScreen,
  });

export type AppRouter = ReturnType<typeof buildRouter>;

interface AppRouterOptions {
  readonly history?: RouterHistory;
}

export const createAppRouter = ({ history }: AppRouterOptions = {}): AppRouter =>
  buildRouter(history);

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
