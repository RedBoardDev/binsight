import '@app/core/theme/globals.css';
import { syncReducedMotionAttribute } from '@app/applications/Shared/Motion/Ui/reducedMotionStore';
import { AppProviders } from '@app/core/AppProviders';
import { activateInitialLocale } from '@app/core/i18n/localeActivation';
import { registerStaleChunkReload } from '@app/core/pwa/staleChunkReload';
import { UpdatePrompt } from '@app/core/pwa/UpdatePrompt';
import { createQueryClient } from '@app/core/query/createQueryClient';
import { RootErrorBoundary } from '@app/core/RootErrorBoundary';
import { redirectToSignIn } from '@app/core/redirectToSignIn';
import { createAppRouter } from '@app/core/router';
import { syncThemeAttribute } from '@app/core/theme/themeStore';
import { apiClient } from '@app/lib/api/client';
import { createUnauthorizedMiddleware } from '@app/lib/api/unauthorizedMiddleware';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html has no #root element');
}

registerStaleChunkReload();
syncReducedMotionAttribute();
syncThemeAttribute();

// Activated before the first render, so no component ever renders without its messages.
await activateInitialLocale();

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });
apiClient.use(createUnauthorizedMiddleware(() => redirectToSignIn({ router, queryClient })));

createRoot(rootElement).render(
  <StrictMode>
    <RootErrorBoundary>
      <AppProviders queryClient={queryClient}>
        <UpdatePrompt />
        <RouterProvider router={router} />
      </AppProviders>
    </RootErrorBoundary>
  </StrictMode>,
);
