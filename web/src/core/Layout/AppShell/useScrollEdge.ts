import { useSyncExternalStore } from 'react';

const SCROLLED_AFTER_PX = 4;

const subscribeToScroll = (onChange: () => void): (() => void) => {
  window.addEventListener('scroll', onChange, { passive: true });
  return () => window.removeEventListener('scroll', onChange);
};

const isScrolled = (): boolean => window.scrollY > SCROLLED_AFTER_PX;

// Whether the page has scrolled under the top bar: the bar only marks its edge then. A boolean
// snapshot, so scrolling re-renders the bar twice at most, not on every frame.
export const useScrollEdge = (): boolean => useSyncExternalStore(subscribeToScroll, isScrolled);
