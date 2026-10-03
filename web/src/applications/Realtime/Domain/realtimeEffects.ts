import type { LiveEvent } from '@app/applications/Realtime/Domain/liveEvent';
import type { EntityName } from '@app/applications/Shared/Domain/entityName';

export type RealtimeEffect =
  | { readonly kind: 'heartbeat'; readonly at: string }
  | { readonly kind: 'invalidateEntities'; readonly entities: readonly EntityName[] };

export const toEffects = (event: LiveEvent): RealtimeEffect[] => {
  switch (event.type) {
    case 'heartbeat':
      return [{ kind: 'heartbeat', at: event.server_time }];
    case 'engine_status':
      return [{ kind: 'invalidateEntities', entities: ['Health'] }];
  }
};
