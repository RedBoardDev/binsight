import {
  type RealtimeStatus,
  realtimeStatusStore,
} from '@app/applications/Realtime/Ui/realtimeStatusStore';
import { useSyncExternalStore } from 'react';

export const useRealtimeStatus = (): RealtimeStatus =>
  useSyncExternalStore(realtimeStatusStore.subscribe, realtimeStatusStore.getSnapshot);
