import '@app/core/theme/globals.css';
import { syncReducedMotionAttribute } from '@app/applications/Shared/Motion/Ui/reducedMotionStore';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { AppProviders } from '@app/core/AppProviders';
import { activateInitialLocale } from '@app/core/i18n/localeActivation';
import { createQueryClient } from '@app/core/query/createQueryClient';
import { useGlobalShortcuts } from '@app/core/Shortcut/useGlobalShortcuts';
import { syncThemeAttribute } from '@app/core/theme/themeStore';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HarnessPage } from './HarnessPage';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('the harness page has no #root element');
}

syncReducedMotionAttribute();
syncThemeAttribute();
await activateInitialLocale();

// The same keys as the app shell: "." hides the amounts and "u" switches the currency.
const HarnessShortcuts = () => {
  useGlobalShortcuts({
    'toggle-currency': displayPreferenceStore.toggleCurrency,
    'toggle-hidden-amounts': displayPreferenceStore.toggleAmountsHidden,
  });
  return null;
};

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders queryClient={createQueryClient()}>
      <HarnessShortcuts />
      <HarnessPage />
    </AppProviders>
  </StrictMode>,
);
