import { describe, expect, it, vi } from 'vitest';
import { BLOCKHASH_MAX_STALE_MS, BlockhashCache } from './blockhash-cache';

describe('BlockhashCache', () => {
  it('throws if read before being primed (fail loud, no bogus hash)', () => {
    const c = new BlockhashCache(async () => ({ blockhash: 'bh', lastValidBlockHeight: 1 }));
    expect(() => c.get()).toThrow();
  });

  it('refresh then get returns the fetched blockhash + expiry pair', async () => {
    let n = 0;
    const c = new BlockhashCache(async () => {
      n += 1;
      return { blockhash: `bh${n}`, lastValidBlockHeight: 100 + n };
    });
    await c.refresh();
    expect(c.get()).toEqual({ blockhash: 'bh1', lastValidBlockHeight: 101 });
    await c.refresh();
    expect(c.get()).toEqual({ blockhash: 'bh2', lastValidBlockHeight: 102 });
  });

  it('keeps the last good value if a refresh fails (transient RPC blip must not blank the cache)', async () => {
    let fail = false;
    const c = new BlockhashCache(async () => {
      if (fail) throw new Error('rpc down');
      return { blockhash: 'good', lastValidBlockHeight: 42 };
    });
    await c.refresh();
    expect(c.get()).toEqual({ blockhash: 'good', lastValidBlockHeight: 42 });
    fail = true;
    await c.refresh(); // fails → keeps 'good'
    expect(c.get()).toEqual({ blockhash: 'good', lastValidBlockHeight: 42 });
  });

  it('getFresh() returns undefined before priming (a MISS → sign path fetches a live blockhash)', () => {
    const c = new BlockhashCache(async () => ({ blockhash: 'bh', lastValidBlockHeight: 1 }));
    expect(c.getFresh()).toBeUndefined();
  });

  it('getFresh() returns the cached pair while within the staleness cap, a MISS once past it', async () => {
    // WHY #51: on the sign path a blockhash older than the cap may be at/near expiry; returning it would make a
    // leader-close degrade to a 30s+ timeout during RPC instability (the only time the cache stays stale). At the
    // boundary it is still fresh (inclusive); one ms past → a MISS so the vault fetches a live blockhash instead.
    let clock = 1_000_000;
    const c = new BlockhashCache(
      async () => ({ blockhash: 'bh', lastValidBlockHeight: 42 }),
      2_000,
      () => clock,
    );
    await c.refresh(); // fetchedAt = 1_000_000
    expect(c.getFresh()).toEqual({ blockhash: 'bh', lastValidBlockHeight: 42 });
    clock += BLOCKHASH_MAX_STALE_MS; // exactly at the cap → still fresh (age == cap is not "past" it)
    expect(c.getFresh()).toEqual({ blockhash: 'bh', lastValidBlockHeight: 42 });
    clock += 1; // one ms past the cap → stale → MISS
    expect(c.getFresh()).toBeUndefined();
  });

  it('getFresh() goes stale when refreshes keep FAILING (RPC outage) even though get() keeps the last value', async () => {
    // WHY #51: a failed refresh must not bump fetchedAt, so a value kept across a prolonged outage ages out of the
    // sign path (getFresh → MISS) while still serving the non-critical serialize path (get → last good value).
    let clock = 0;
    let fail = false;
    const c = new BlockhashCache(
      async () => {
        if (fail) throw new Error('rpc down');
        return { blockhash: 'good', lastValidBlockHeight: 7 };
      },
      2_000,
      () => clock,
    );
    await c.refresh(); // fetchedAt = 0
    fail = true;
    clock = BLOCKHASH_MAX_STALE_MS + 1;
    await c.refresh(); // fails → value kept, fetchedAt NOT bumped
    expect(c.get()).toEqual({ blockhash: 'good', lastValidBlockHeight: 7 }); // serialize path still served
    expect(c.getFresh()).toBeUndefined(); // sign path no longer trusts the aged value
  });

  it('start() primes (get ready) then refreshes on the timer; stop() halts it', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchFn = vi.fn(async () => {
        n += 1;
        return { blockhash: `bh${n}`, lastValidBlockHeight: n };
      });
      const c = new BlockhashCache(fetchFn, 2_000);
      await c.start(); // primes immediately → get() ready
      expect(c.get().blockhash).toBe('bh1');
      await vi.advanceTimersByTimeAsync(2_000); // one background refresh
      expect(c.get().blockhash).toBe('bh2');
      c.stop();
      await vi.advanceTimersByTimeAsync(6_000); // no more refreshes after stop
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
