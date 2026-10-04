import { useSyncExternalStore } from 'react';

// A software keyboard takes at least this much of the window; a browser bar that slides away
// takes much less.
const KEYBOARD_MIN_HEIGHT_PX = 150;
const ZOOM_TOLERANCE = 0.01;

const subscribeToViewport = (onChange: () => void): (() => void) => {
  window.visualViewport?.addEventListener('resize', onChange);
  return () => window.visualViewport?.removeEventListener('resize', onChange);
};

const isKeyboardOpen = (): boolean => {
  // Typed as never undefined, but some environments (jsdom, older WebViews) have no visualViewport.
  const viewport = window.visualViewport ?? null;
  // A pinch-zoom shrinks the visual viewport too, and must not take the navigation away.
  const isZoomed = viewport !== null && Math.abs(viewport.scale - 1) > ZOOM_TOLERANCE;
  return (
    viewport !== null && !isZoomed && window.innerHeight - viewport.height > KEYBOARD_MIN_HEIGHT_PX
  );
};

export const useKeyboardOpen = (): boolean =>
  useSyncExternalStore(subscribeToViewport, isKeyboardOpen);
