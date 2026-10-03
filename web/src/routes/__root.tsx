import type { RouterContext } from '@app/core/routerContext';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';

export const Route = createRootRouteWithContext<RouterContext>()({ component: Outlet });
