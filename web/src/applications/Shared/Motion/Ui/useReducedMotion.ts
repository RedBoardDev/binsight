import { reducedMotionStore } from '@app/applications/Shared/Motion/Ui/reducedMotionStore';
import { useSyncExternalStore } from 'react';

// For the motion that JavaScript drives (a scrub, a chart library); CSS reads the attribute.
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(reducedMotionStore.subscribe, reducedMotionStore.isReduced);
