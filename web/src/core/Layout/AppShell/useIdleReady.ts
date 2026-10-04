import { useEffect, useState } from 'react';

// A menu or a sheet that no one opens during the first paint is mounted once the browser is idle:
// its code stays out of the first load, and it is ready before anyone presses it.
export const useIdleReady = (): boolean => {
  const [isReady, setReady] = useState(false);

  useEffect(() => {
    const markReady = (): void => setReady(true);
    // Safari has no requestIdleCallback.
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(markReady);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(markReady);
    return () => window.clearTimeout(id);
  }, []);

  return isReady;
};
