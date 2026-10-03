import { LocaleProvider } from '@app/core/i18n/LocaleProvider';
import { Toast } from '@heroui/react';
import type { ReactNode } from 'react';

interface AppProvidersProps {
  children: ReactNode;
}

export const AppProviders = ({ children }: AppProvidersProps) => (
  <LocaleProvider>
    <Toast.Provider placement="top" />
    {children}
  </LocaleProvider>
);
