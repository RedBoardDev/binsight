import { type NavigateOptions, Outlet, type ToOptions, useRouter } from '@tanstack/react-router';
import { RouterProvider } from 'react-aria-components';

// HeroUI components that take an href (Link, Tabs, Table rows, menu items) navigate through the
// router, without a reload, and keep the browser's own middle-click and cmd-click. Their href is a
// path string or a typed router location ({ to, search }).
declare module 'react-aria-components' {
  interface RouterConfig {
    href: string | ToOptions;
    routerOptions: Omit<NavigateOptions, keyof ToOptions>;
  }
}

const EXTERNAL_HREF = /^[a-z][a-z\d+.-]*:/i;

// A path string goes through the router too: its search middlewares (the retained wallet and
// period) then reach the address a middle-click opens, as they reach a plain click.
const resolveHref = (router: ReturnType<typeof useRouter>, href: string | ToOptions): string => {
  if (typeof href !== 'string') {
    return router.buildLocation(href).href;
  }
  if (EXTERNAL_HREF.test(href)) {
    return href;
  }
  const url = new URL(href, window.location.origin);
  return router.buildLocation({ to: url.pathname, search: router.options.parseSearch(url.search) })
    .href;
};

export const AriaRouterBridge = () => {
  const router = useRouter();

  return (
    <RouterProvider
      navigate={(href, options) =>
        typeof href === 'string'
          ? router.navigate({ ...options, href })
          : router.navigate({ ...options, ...href })
      }
      useHref={(href) => resolveHref(router, href)}
    >
      <Outlet />
    </RouterProvider>
  );
};
