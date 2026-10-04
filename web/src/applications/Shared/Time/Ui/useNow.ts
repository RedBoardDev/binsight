import { useSyncExternalStore } from 'react';

// "3 min ago" must age: one shared clock ticks for every relative time on the page, twice a
// minute, instead of a timer per row.
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

const subscribe = (onTick: () => void): (() => void) => {
  listeners.add(onTick);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const listener of listeners) {
        listener();
      }
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onTick);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

const readNow = (): number => now;

export const useNow = (): number => useSyncExternalStore(subscribe, readNow);
