import { AriaRouterBridge } from '@app/core/AriaRouterBridge';
import type { RouterContext } from '@app/core/routerContext';
import { createRootRouteWithContext } from '@tanstack/react-router';

export const Route = createRootRouteWithContext<RouterContext>()({ component: AriaRouterBridge });
