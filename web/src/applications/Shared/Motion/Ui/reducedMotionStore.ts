import {
  isMotionReduced,
  MOTION_STORAGE_KEY,
  type MotionPreference,
  parseMotionPreference,
} from '@app/applications/Shared/Motion/Domain/motionPreference';
import { readPreference, storePreference } from '@app/core/preferenceStorage';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

interface ReducedMotionStore {
  readonly getPreference: () => MotionPreference;
  readonly setPreference: (preference: MotionPreference) => void;
  readonly isReduced: () => boolean;
  readonly subscribe: (onChange: () => void) => () => void;
}

const systemPrefersReducedMotion = (): boolean => window.matchMedia(REDUCED_MOTION_QUERY).matches;

export const createReducedMotionStore = (): ReducedMotionStore => {
  let preference = parseMotionPreference(readPreference(MOTION_STORAGE_KEY));
  const listeners = new Set<() => void>();

  return {
    getPreference: () => preference,
    setPreference: (next) => {
      preference = next;
      storePreference(MOTION_STORAGE_KEY, next);
      for (const listener of listeners) {
        listener();
      }
    },
    isReduced: () => isMotionReduced(preference, systemPrefersReducedMotion()),
    subscribe: (onChange) => {
      const query = window.matchMedia(REDUCED_MOTION_QUERY);
      listeners.add(onChange);
      query.addEventListener('change', onChange);
      return () => {
        listeners.delete(onChange);
        query.removeEventListener('change', onChange);
      };
    },
  };
};

export const reducedMotionStore = createReducedMotionStore();

// CSS and HeroUI read one attribute, data-reduce-motion on <html>, whichever side asked for reduced
// motion. Called once at startup, before the first render; returns the way to stop.
export const syncReducedMotionAttribute = (): (() => void) => {
  const apply = (): void => {
    const root = document.documentElement;
    if (reducedMotionStore.isReduced()) {
      root.dataset.reduceMotion = 'true';
    } else {
      delete root.dataset.reduceMotion;
    }
  };
  apply();
  return reducedMotionStore.subscribe(apply);
};
