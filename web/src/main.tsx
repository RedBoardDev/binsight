import '@app/core/theme/globals.css';
import { LocaleProvider } from '@app/core/i18n/LocaleProvider';
import { LocaleSwitcher } from '@app/core/i18n/LocaleSwitcher';
import { activateInitialLocale } from '@app/core/i18n/localeActivation';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html has no #root element');
}

// Activated before the first render, so no component ever renders without its messages.
await activateInitialLocale();

createRoot(rootElement).render(
  <StrictMode>
    <LocaleProvider>
      <main className="grid h-full place-content-center justify-items-center gap-6">
        <h1 className="font-semibold text-3xl text-accent">binsight</h1>
        <LocaleSwitcher />
      </main>
    </LocaleProvider>
  </StrictMode>,
);
