import { shouldReloadForStaleChunk } from '@app/core/pwa/staleChunkReload';
import { describe, expect, it } from 'vitest';

describe('shouldReloadForStaleChunk', () => {
  const now = 1_000_000;

  it('reloads on the first failure', () => {
    expect(shouldReloadForStaleChunk(null, now)).toBe(true);
  });

  it('does not reload again within ten seconds', () => {
    expect(shouldReloadForStaleChunk(String(now - 9_999), now)).toBe(false);
  });

  it('reloads again once ten seconds have passed', () => {
    expect(shouldReloadForStaleChunk(String(now - 10_000), now)).toBe(true);
  });

  it('reloads when the stored time is unreadable', () => {
    expect(shouldReloadForStaleChunk('garbage', now)).toBe(true);
  });
});
