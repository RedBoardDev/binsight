import { SolanaMarkDefs } from '@app/applications/Shared/Unit/Ui/SolanaMarkDefs';
import { LocaleProvider } from '@app/core/i18n/LocaleProvider';
import { Toast } from '@heroui/react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

interface AppProvidersProps {
  queryClient: QueryClient;
  children: ReactNode;
}

export const AppProviders = ({ queryClient, children }: AppProvidersProps) => (
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <Toast.Provider placement="top" />
      <SolanaMarkDefs />
      {children}
    </LocaleProvider>
  </QueryClientProvider>
);
