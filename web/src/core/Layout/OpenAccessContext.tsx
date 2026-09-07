'use client';

import { createContext, type ReactNode, useContext } from 'react';

/**
 * Open-access mode, seeded server-side from the backend's `/config/app` and read by the shells to
 * drop the multi-wallet and notification surfaces. Defaults to the secure behaviour outside a
 * provider.
 */
const OpenAccessContext = createContext(false);

interface OpenAccessProviderProps {
  value: boolean;
  children: ReactNode;
}

export const OpenAccessProvider = ({ value, children }: OpenAccessProviderProps) => (
  <OpenAccessContext.Provider value={value}>{children}</OpenAccessContext.Provider>
);

export const useOpenAccess = (): boolean => useContext(OpenAccessContext);
