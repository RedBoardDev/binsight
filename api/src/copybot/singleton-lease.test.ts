import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  type LeaseBus,
  planLeaseRenew,
  startLeaseRenewLoop,
} from './singleton-lease';

const silentLog = pino({ level: 'silent' });

// planLeaseRenew is the #150 split-brain guard, now SHARED by brain (A6-04) + coffre. A few anchor cases here; the
// coffre suite exercises it further via the re-export.
describe('planLeaseRenew — split-brain decision', () => {
  const TTL = 30_000;
  const LAST = 1_000;
  it('renew ok → renewed', () => {
    expect(planLeaseRenew({ ok: true }, LAST + 1, LAST, TTL)).toEqual({ action: 'renewed' });
  });
  it('renew resolves !ok (lease taken) → exit lost', () => {
    expect(planLeaseRenew({ ok: false }, LAST + 1, LAST, TTL)).toEqual({
      action: 'exit',
      reason: 'lost',
    });
  });
  it('renew error still within the TTL → retry; past the TTL → exit expired (Redis outage > lease)', () => {
    expect(planLeaseRenew({ error: 'down' }, LAST + TTL, LAST, TTL)).toEqual({ action: 'retry' }); // == TTL, strict >
    expect(planLeaseRenew({ error: 'down' }, LAST + TTL + 1, LAST, TTL)).toEqual({
      action: 'exit',
      reason: 'expired',
    });
  });
});

// startLeaseRenewLoop drives the renew tick + enforces the exit-on-lost guard. WHY it matters — a second brain
// (A6-04) or coffre (#150) must exit the instant exclusivity is provably gone; a live holder must NEVER spuriously
// exit. Fake timers + the vitest-mocked Date.now let us prove both without waiting real seconds.
describe('startLeaseRenewLoop — renew loop + exit-on-lost', () => {
  const makeBus = (renew: () => Promise<boolean>): LeaseBus => ({
    acquireLease: async () => true,
    renewLease: renew,
  });

  it('a successful renew keeps the lease — never calls onLost', async () => {
    vi.useFakeTimers();
    try {
      const onLost = vi.fn();
      const timer = startLeaseRenewLoop({
        bus: makeBus(async () => true),
        key: 'k',
        instanceId: 'i',
        role: 'brain',
        log: silentLog,
        onLost,
      });
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 3); // three healthy ticks
      expect(onLost).not.toHaveBeenCalled();
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a renew that resolves !ok (lease taken) → onLost(lost) immediately', async () => {
    vi.useFakeTimers();
    try {
      const onLost = vi.fn();
      const timer = startLeaseRenewLoop({
        bus: makeBus(async () => false),
        key: 'k',
        instanceId: 'i',
        role: 'brain',
        log: silentLog,
        onLost,
      });
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
      expect(onLost).toHaveBeenCalledWith('lost');
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews that keep ERRORING retry within the TTL, then onLost(expired) once the TTL is exceeded', async () => {
    vi.useFakeTimers();
    try {
      const onLost = vi.fn();
      const timer = startLeaseRenewLoop({
        bus: makeBus(async () => {
          throw new Error('redis down');
        }),
        key: 'k',
        instanceId: 'i',
        role: 'brain',
        log: silentLog,
        onLost,
      });
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS); // +15s: within TTL (30s) → retry
      expect(onLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS); // +30s: == TTL (strict >) → still retry
      expect(onLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS); // +45s: > TTL → the lease has provably expired at Redis
      expect(onLost).toHaveBeenCalledWith('expired');
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes the shared TTL/renew constants (renew is well under the TTL so a live holder never spuriously loses it)', () => {
    expect(LEASE_RENEW_MS).toBeLessThan(LEASE_TTL_MS);
  });
});
