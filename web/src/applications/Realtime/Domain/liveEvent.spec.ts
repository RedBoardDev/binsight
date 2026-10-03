import { parseLiveEvent } from '@app/applications/Realtime/Domain/liveEvent';
import { describe, expect, it } from 'vitest';

describe('parseLiveEvent', () => {
  it('reads a heartbeat', () => {
    const data = '{"type":"heartbeat","server_time":"2026-10-03T21:00:15.123456Z"}';

    expect(parseLiveEvent('heartbeat', data)).toEqual({
      type: 'heartbeat',
      server_time: '2026-10-03T21:00:15.123456Z',
    });
  });

  it('reads an engine status', () => {
    const data = '{"type":"engine_status","status":"running"}';

    expect(parseLiveEvent('engine_status', data)).toEqual({
      type: 'engine_status',
      status: 'running',
    });
  });

  it('drops a frame that is not JSON', () => {
    expect(parseLiveEvent('heartbeat', 'not json')).toBeNull();
  });

  it('drops a payload of an unexpected shape', () => {
    expect(
      parseLiveEvent('engine_status', '{"type":"engine_status","status":"exploded"}'),
    ).toBeNull();
  });

  it('drops a payload whose type differs from the event name', () => {
    const data = '{"type":"engine_status","status":"running"}';

    expect(parseLiveEvent('heartbeat', data)).toBeNull();
  });
});
