import { dataTimestamp, isCatchingUp } from '@app/applications/Overview/Domain/dataFreshness';
import { describe, expect, it } from 'vitest';

describe('dataTimestamp', () => {
  it('dates lagging figures from before the lag, not from the moment they were read', () => {
    expect(
      dataTimestamp({ as_of: '2026-10-06T14:30:00Z', state: 'lagging', lag_seconds: 180 }),
    ).toBe('2026-10-06T14:27:00.000Z');
  });

  it('keeps the reading instant when nothing lags or the lag is unknown', () => {
    expect(dataTimestamp({ as_of: '2026-10-06T14:30:00Z', state: 'live', lag_seconds: null })).toBe(
      '2026-10-06T14:30:00Z',
    );
    expect(
      dataTimestamp({ as_of: '2026-10-06T14:30:00Z', state: 'lagging', lag_seconds: null }),
    ).toBe('2026-10-06T14:30:00Z');
  });
});

describe('isCatchingUp', () => {
  it('says a wallet catches up only while the server reports it lagging', () => {
    expect(isCatchingUp({ as_of: '2026-10-06T14:30:00Z', state: 'lagging' })).toBe(true);
    expect(isCatchingUp({ as_of: '2026-10-06T14:30:00Z', state: 'live' })).toBe(false);
  });
});
