import { useRef, useTransition } from 'react';

interface AsyncAction<Args extends unknown[]> {
  readonly run: (...args: Args) => void;
  readonly isPending: boolean;
}

// One call per button, not one per hook: with a shared flag, pressing "archive" on one row would
// spin every button that uses the same actions.
export const useAsyncAction = <Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown>,
): AsyncAction<Args> => {
  const [isPending, startTransition] = useTransition();
  // `isPending` alone is not enough: a `run` captured before the pending render (an Enter-key
  // submit, a memoised handler) would send the action a second time.
  const isInFlight = useRef(false);

  const run = (...args: Args): void => {
    if (isInFlight.current) {
      return;
    }
    isInFlight.current = true;
    startTransition(async () => {
      try {
        await action(...args);
      } finally {
        isInFlight.current = false;
      }
    });
  };

  return { run, isPending };
};
