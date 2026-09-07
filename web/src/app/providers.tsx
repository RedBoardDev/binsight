'use client';

import { createQueryClient } from '@app/applications/Shared/Api/queryClient';
import { Toast } from '@heroui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { type PropsWithChildren, useState } from 'react';

export const Providers = ({ children }: PropsWithChildren) => {
  // Created once per browser session, inside state — a module-level client would be shared across
  // requests on the server and leak one user's cache into another's render.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toast.Provider placement="bottom" />
    </QueryClientProvider>
  );
};
