import { useSyncExternalStore } from 'react';

// The desktop layout starts where the top bar does (lg, 64rem): a drawer slides from the right
// there, a sheet rises from the bottom below.
const DESKTOP_QUERY = '(min-width: 64rem)';

const subscribe = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

const isDesktop = (): boolean => window.matchMedia(DESKTOP_QUERY).matches;

export const useIsDesktop = (): boolean => useSyncExternalStore(subscribe, isDesktop);
