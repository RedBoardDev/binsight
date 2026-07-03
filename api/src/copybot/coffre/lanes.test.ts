import { describe, expect, it } from 'vitest';
import { INVALID_PAYLOAD_LANE, laneKeyOf, SigningLanes } from './lanes';

/** A manually-resolved gate so tests control exactly when a lane task finishes. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

const flush = async (): Promise<void> => {
  // Drain the microtask queue a few rounds so every settled promise chain has propagated.
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('laneKeyOf — the lane is the SIGNED userId', () => {
  it('a payload with a userId routes to that user lane', () => {
    expect(laneKeyOf({ userId: 'user-a' })).toBe('user-a');
  });

  it('null / malformed payloads (failed HMAC, missing or non-string userId) share the invalid lane', () => {
    // WHY: these are rejected by process1 without chain I/O, so one shared lane cannot stall anyone — while
    // routing them onto a REAL user's lane (e.g. a forged userId object) could interleave junk into that user.
    expect(laneKeyOf(null)).toBe(INVALID_PAYLOAD_LANE);
    expect(laneKeyOf({})).toBe(INVALID_PAYLOAD_LANE);
    expect(laneKeyOf({ userId: 42 })).toBe(INVALID_PAYLOAD_LANE);
    expect(laneKeyOf({ userId: '' })).toBe(INVALID_PAYLOAD_LANE);
    expect(laneKeyOf('junk')).toBe(INVALID_PAYLOAD_LANE);
  });
});

describe('SigningLanes — FIFO within a user, concurrent across users, globally bounded', () => {
  it('WITHIN a user: strict FIFO — a task starts only after the previous one finished (never overlaps)', async () => {
    // WHY: one user's commands must apply in bus order (an open must broadcast before its close); overlapping
    // them could sign the close of a position whose open is still in flight.
    const lanes = new SigningLanes();
    const log: string[] = [];
    const g1 = gate();
    const t1 = lanes.dispatch('u', async () => {
      log.push('start-1');
      await g1.promise;
      log.push('end-1');
    });
    const t2 = lanes.dispatch('u', async () => {
      log.push('start-2');
      log.push('end-2');
    });
    await flush();
    expect(log).toEqual(['start-1']); // task 2 has NOT started while task 1 runs
    g1.open();
    await Promise.all([t1, t2]);
    expect(log).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('★ ACROSS users: a stalled lane A does not delay lane B (the ULTRACODE #22/#31 head-of-line kill)', async () => {
    // WHY: this is the defect this increment exists for — one slow/unconfirmed command of user A must never
    // block user B's CLOSE. B's task completes while A's is still pending.
    const lanes = new SigningLanes();
    const stallA = gate();
    const done: string[] = [];
    const a = lanes.dispatch('user-a', async () => {
      await stallA.promise; // A never finishes (until cleanup)
      done.push('a');
    });
    const b = lanes.dispatch('user-b', async () => {
      done.push('b');
    });
    await b; // resolves WITHOUT touching A's gate
    expect(done).toEqual(['b']);
    stallA.open(); // cleanup
    await a;
  });

  it('a rejected task isolates to its caller — the SAME lane still runs the next task (no wedged user)', async () => {
    const lanes = new SigningLanes();
    const boom = lanes.dispatch('u', async () => {
      throw new Error('boom');
    });
    await expect(boom).rejects.toThrow('boom');
    await expect(lanes.dispatch('u', async () => 'next')).resolves.toBe('next');
  });

  it('the global cap bounds how many lanes sign at once (shared RPC key), FIFO once a permit frees', async () => {
    // WHY: all lanes share ONE RPC key today — unbounded cross-user fan-out would burst the RPC. With a cap of 2,
    // the 3rd user's task starts only when a permit frees.
    const lanes = new SigningLanes(2);
    const started: string[] = [];
    const gates = { a: gate(), b: gate(), c: gate() };
    const run = (key: 'a' | 'b' | 'c') =>
      lanes.dispatch(key, async () => {
        started.push(key);
        await gates[key].promise;
      });
    const all = [run('a'), run('b'), run('c')];
    await flush();
    expect(started).toEqual(['a', 'b']); // the cap holds: c waits
    gates.a.open();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']); // the freed permit goes to c
    gates.b.open();
    gates.c.open();
    await Promise.all(all);
  });
});
