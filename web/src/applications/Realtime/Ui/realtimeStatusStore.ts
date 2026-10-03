import type { StreamState } from '@app/lib/sse/eventStream';

export interface RealtimeStatus {
  readonly state: StreamState;
  readonly lastHeartbeatAt: string | null;
}

interface RealtimeStatusStore {
  readonly getSnapshot: () => RealtimeStatus;
  readonly subscribe: (onChange: () => void) => () => void;
  readonly setState: (state: StreamState) => void;
  readonly recordHeartbeat: (at: string) => void;
  readonly reset: () => void;
}

const INITIAL_STATUS: RealtimeStatus = { state: 'connecting', lastHeartbeatAt: null };

export const createRealtimeStatusStore = (): RealtimeStatusStore => {
  let status = INITIAL_STATUS;
  const listeners = new Set<() => void>();

  // Each change makes a new object: useSyncExternalStore compares snapshots by identity.
  const update = (next: RealtimeStatus): void => {
    status = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => status,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    setState: (state) => {
      if (state !== status.state) {
        update({ ...status, state });
      }
    },
    recordHeartbeat: (at) => update({ ...status, lastHeartbeatAt: at }),
    reset: () => update(INITIAL_STATUS),
  };
};

export const realtimeStatusStore = createRealtimeStatusStore();
