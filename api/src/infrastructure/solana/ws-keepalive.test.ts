import { describe, expect, it } from 'vitest';
import { isWsDead, WS_MAX_UNANSWERED_PINGS, WS_PING_INTERVAL_MS } from './ws-keepalive';

describe('isWsDead — unanswered-keepalive liveness (#52)', () => {
  it('is alive until the max: 0 and 1 unanswered are not death (a single missed tick is normal jitter)', () => {
    // WHY #52: death must be UNANSWERED keepalives, not silence — an idle-but-alive connection replies and resets
    // the counter, so it never reaches the threshold and is never churned. One missed reply is not yet conclusive.
    expect(isWsDead(0)).toBe(false);
    expect(isWsDead(WS_MAX_UNANSWERED_PINGS - 1)).toBe(false);
  });

  it('is dead at and beyond the threshold (a genuinely dead socket is caught within ~2 ticks, not 300s)', () => {
    expect(isWsDead(WS_MAX_UNANSWERED_PINGS)).toBe(true);
    expect(isWsDead(WS_MAX_UNANSWERED_PINGS + 1)).toBe(true);
  });

  it('honors a custom max (boundary is inclusive)', () => {
    expect(isWsDead(2, 3)).toBe(false);
    expect(isWsDead(3, 3)).toBe(true);
  });

  it('pings often enough to beat Helius’s ~10-min idle cutoff', () => {
    expect(WS_PING_INTERVAL_MS).toBeLessThanOrEqual(55_000);
  });
});
