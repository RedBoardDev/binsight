import { toEffects } from '@app/applications/Realtime/Domain/realtimeEffects';
import { describe, expect, it } from 'vitest';

describe('toEffects', () => {
  it('records the time of a heartbeat', () => {
    expect(toEffects({ type: 'heartbeat', server_time: '2026-10-03T21:00:15Z' })).toEqual([
      { kind: 'heartbeat', at: '2026-10-03T21:00:15Z' },
    ]);
  });

  it('refreshes the health when the engine status changes', () => {
    expect(toEffects({ type: 'engine_status', status: 'stopping' })).toEqual([
      { kind: 'invalidateEntities', entities: ['Health'] },
    ]);
  });
});
