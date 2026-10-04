import { scopeRouteOptions } from '@app/applications/Shared/Scope/Ui/scopeRouteOptions';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createTestQueryClient } from './createTestQueryClient';
import { renderWithProviders } from './renderWithProviders';

// A shared control (period pills, wallet switcher) inside the scope of the signed-in pages, without
// the app's own pages: "/" shows the control, "/history" is another page to go to. Their paths are
// the app's, so links type-check against its routes.
export const renderInScope = async (ui: ReactElement, path = '/') => {
  const rootRoute = createRootRoute({ component: Outlet });
  // The id of the app's own layout route, which the scope hooks read their search from.
  const scopeRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_authenticated',
    ...scopeRouteOptions,
    component: Outlet,
  });
  const pageRoute = createRoute({
    getParentRoute: () => scopeRoute,
    path: '/',
    component: () => (
      <>
        <h1>Page</h1>
        {ui}
        <Link to="/history">Next page</Link>
      </>
    ),
  });
  const nextRoute = createRoute({
    getParentRoute: () => scopeRoute,
    path: '/history',
    component: () => <h1>Next page</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([scopeRoute.addChildren([pageRoute, nextRoute])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const rendered = renderWithProviders(<RouterProvider router={router} />, {
    queryClient: createTestQueryClient(),
  });
  await screen.findByRole('heading', { name: 'Page' });
  return { ...rendered, router };
};
