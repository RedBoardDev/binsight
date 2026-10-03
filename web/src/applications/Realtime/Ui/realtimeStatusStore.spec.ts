import { createRealtimeStatusStore } from '@app/applications/Realtime/Ui/realtimeStatusStore';
import { describe, expect, it, vi } from 'vitest';

describe('createRealtimeStatusStore', () => {
  it('starts connecting, with no heartbeat yet', () => {
    expect(createRealtimeStatusStore().getSnapshot()).toEqual({
      state: 'connecting',
      lastHeartbeatAt: null,
    });
  });

  it('records the state and the last heartbeat, and tells its subscribers', () => {
    const store = createRealtimeStatusStore();
    const onChange = vi.fn();
    store.subscribe(onChange);

    store.setState('open');
    store.recordHeartbeat('2026-10-03T21:00:15Z');

    expect(store.getSnapshot()).toEqual({ state: 'open', lastHeartbeatAt: '2026-10-03T21:00:15Z' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps the same snapshot when the state does not change', () => {
    const store = createRealtimeStatusStore();
    const before = store.getSnapshot();

    store.setState('connecting');

    expect(store.getSnapshot()).toBe(before);
  });

  it('stops telling a subscriber that unsubscribed', () => {
    const store = createRealtimeStatusStore();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);

    unsubscribe();
    store.setState('paused');

    expect(onChange).not.toHaveBeenCalled();
  });
});
