import { AriaRouterBridge } from '@app/core/AriaRouterBridge';
import { Link } from '@heroui/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  retainSearchParams,
} from '@tanstack/react-router';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

// Hrefs are typed against the app's registered routes, so the test router reuses one of its paths.
const createTestRouter = (path = '/') => {
  const rootRoute = createRootRoute({
    component: AriaRouterBridge,
    search: { middlewares: [retainSearchParams(['redirect'])] },
  });
  const routes = [
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => (
        <>
          <Link href="/login">By path</Link>
          <Link href={{ to: '/login', search: { redirect: '/history' } }}>By location</Link>
          <Link href="https://solscan.io">Elsewhere</Link>
        </>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: '/login', component: () => 'Sign in' }),
  ];
  return createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
};

describe('AriaRouterBridge', () => {
  it('lets a HeroUI link navigate through the router', async () => {
    const router = createTestRouter();
    const user = userEvent.setup();
    renderWithProviders(<RouterProvider router={router} />);

    await user.click(await screen.findByRole('link', { name: 'By path' }));

    expect(await screen.findByText('Sign in')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('gives a typed location its real address', async () => {
    const router = createTestRouter();
    renderWithProviders(<RouterProvider router={router} />);

    expect(await screen.findByRole('link', { name: 'By location' })).toHaveAttribute(
      'href',
      '/login?redirect=%2Fhistory',
    );
  });

  it('keeps the retained search params in the address of a path', async () => {
    const router = createTestRouter('/?redirect=%2Fstats');
    renderWithProviders(<RouterProvider router={router} />);

    expect(await screen.findByRole('link', { name: 'By path' })).toHaveAttribute(
      'href',
      '/login?redirect=%2Fstats',
    );
    expect(screen.getByRole('link', { name: 'Elsewhere' })).toHaveAttribute(
      'href',
      'https://solscan.io',
    );
  });
});
