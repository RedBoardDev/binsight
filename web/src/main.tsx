import '@app/core/theme/globals.css';
import { AppProviders } from '@app/core/AppProviders';
import { activateInitialLocale } from '@app/core/i18n/localeActivation';
import { createQueryClient } from '@app/core/query/createQueryClient';
import { RootErrorBoundary } from '@app/core/RootErrorBoundary';
import { createAppRouter } from '@app/core/router';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html has no #root element');
}

// Activated before the first render, so no component ever renders without its messages.
await activateInitialLocale();

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });

createRoot(rootElement).render(
  <StrictMode>
    <RootErrorBoundary>
      <AppProviders queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>
    </RootErrorBoundary>
  </StrictMode>,
);
