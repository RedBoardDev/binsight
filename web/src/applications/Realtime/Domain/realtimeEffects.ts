import type { LiveEvent } from '@app/applications/Realtime/Domain/liveEvent';

export type RealtimeEffect =
  | { readonly kind: 'heartbeat'; readonly at: string }
  | { readonly kind: 'refreshActiveQueries' };

export const toEffects = (event: LiveEvent): RealtimeEffect[] => {
  switch (event.type) {
    case 'heartbeat':
      return [{ kind: 'heartbeat', at: event.server_time }];
    case 'engine_status':
      return [{ kind: 'refreshActiveQueries' }];
    case 'wallet_sync_changed':
      return [{ kind: 'refreshActiveQueries' }];
  }
};
