import { toEffects } from '@app/applications/Realtime/Domain/realtimeEffects';
import { describe, expect, it } from 'vitest';

describe('toEffects', () => {
  it('refreshes active queries when a wallet sync changes', () => {
    expect(
      toEffects({ type: 'wallet_sync_changed', wallet: 'sample-wallet', state: 'error' }),
    ).toEqual([{ kind: 'refreshActiveQueries' }]);
  });

  it('records the time of a heartbeat', () => {
    expect(toEffects({ type: 'heartbeat', server_time: '2026-10-03T21:00:15Z' })).toEqual([
      { kind: 'heartbeat', at: '2026-10-03T21:00:15Z' },
    ]);
  });

  it('refreshes active queries when a status message resynchronizes the stream', () => {
    expect(toEffects({ type: 'engine_status', status: 'stopping' })).toEqual([
      { kind: 'refreshActiveQueries' },
    ]);
  });
});
