import { type AppRouter, createAppRouter } from '@app/core/router';
import type { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { RenderResult } from '@testing-library/react';
import { createTestQueryClient } from './createTestQueryClient';
import { renderWithProviders } from './renderWithProviders';

interface RenderedApp extends RenderResult {
  readonly queryClient: QueryClient;
  readonly router: AppRouter;
}

export const renderAppAt = (path: string): RenderedApp => {
  const queryClient = createTestQueryClient();
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return {
    ...renderWithProviders(<RouterProvider router={router} />, { queryClient }),
    queryClient,
    router,
  };
};
