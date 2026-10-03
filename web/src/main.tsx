import '@app/core/theme/globals.css';
import { LocaleProvider } from '@app/core/i18n/LocaleProvider';
import { activateInitialLocale } from '@app/core/i18n/localeActivation';
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

const router = createAppRouter();

createRoot(rootElement).render(
  <StrictMode>
    <RootErrorBoundary>
      <LocaleProvider>
        <RouterProvider router={router} />
      </LocaleProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
