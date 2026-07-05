import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { purgeRugExitPending, RugExitStore } from './rug-exit-store';

// Fresh in-memory Postgres (PGlite) per suite with the real Drizzle migrations applied — exercises the REAL
// rug_exits / rug_exit_pending tables (SPEC §12: row-level rows replaced the settings-KV JSON blob that failed
// OPEN on corruption — one bad blob wiped the whole suppression set).
const newDb = async (): Promise<Database> => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
};
const db = await newDb();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const USER = 'test-user-1';
const USER_2 = 'test-user-2';
const store = new RugExitStore(db, log, USER);

// A db whose READS (`select`) reject the first `failures` attempts, then delegate to `healthy` — simulates a
// Postgres that is briefly saturated on restart (finding #152). `failures = Infinity` = persistently down. `calls`
// counts read attempts so a test can assert the bounded retry actually retried before failing loud.
const makeFlakyReadDb = (
  healthy: Database,
  failures: number,
): { db: Database; state: { calls: number } } => {
  const state = { calls: 0 };
  const flaky = {
    select: (...args: Parameters<Database['select']>) => {
      state.calls++;
      if (state.calls <= failures) throw new Error('db saturated (transient)');
      return healthy.select(...args); // member call keeps `this === healthy` for the real query
    },
  } as unknown as Database;
  return { db: flaky, state };
};

describe('RugExitStore — durable suppression of re-opening a rug-exited leader position', () => {
  it('an unseeded store loads an empty set', async () => {
    expect((await store.load()).size).toBe(0);
  });

  it('addExited → a FRESH store (restart simulation) reloads the set — suppression survives a brain restart', async () => {
    // WHY: without persistence, a restart would drop the rug-exit memory and the leader's next add would re-enter
    // the rugged position. Each exit is ONE atomic row (no whole-set write-through to corrupt).
    await store.addExited('LEADER_A');
    await store.addExited('LEADER_B');
    const reloaded = await new RugExitStore(db, log, USER).load();
    expect([...reloaded].sort()).toEqual(['LEADER_A', 'LEADER_B']);
  });

  it('re-adding an already-exited leader position is idempotent (no duplicate row, no throw)', async () => {
    await store.addExited('LEADER_A');
    expect([...(await store.load())].sort()).toEqual(['LEADER_A', 'LEADER_B']);
  });

  it('rows are per-user: user #2 rug-exits never suppress user #1 re-opens (SPEC §11)', async () => {
    // WHY: rug-SL is per-tenant risk state — user #2 exiting a rug must not stop user #1 (who never exited it)
    // from copying that leader position, and vice versa.
    const store2 = new RugExitStore(db, log, USER_2);
    await store2.addExited('LEADER_ONLY_U2');
    expect((await store.load()).has('LEADER_ONLY_U2')).toBe(false);
    expect((await store2.load()).has('LEADER_ONLY_U2')).toBe(true);
    expect((await store2.load()).has('LEADER_A')).toBe(false);
  });

  it('a write error is FAIL-SAFE: logged, never thrown (the in-memory set still suppresses this run)', async () => {
    const broken = {
      insert: () => {
        throw new Error('db down');
      },
    } as unknown as Database;
    const failing = new RugExitStore(broken, log, USER);
    await expect(failing.addExited('LEADER_X')).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('RugExitStore — durable rug-exit-PENDING set (retry a failed rug-SL/stop close across a restart)', () => {
  it('an unseeded pending store loads an empty set', async () => {
    expect((await store.loadPending()).size).toBe(0);
  });

  it('addPending → a FRESH store (restart simulation) reloads the set — the re-close retry survives a restart', async () => {
    // WHY: rug-SL is OUR independent crash exit; if its close failed to land and the process restarts, the pending
    // retry must persist so the reconcile keeps re-closing the position until it is confirmed gone (never-miss-close).
    await store.addPending('OUR_A');
    await store.addPending('OUR_B');
    const reloaded = await new RugExitStore(db, log, USER).loadPending();
    expect([...reloaded].sort()).toEqual(['OUR_A', 'OUR_B']);
  });

  it('removePending deletes ONE row — the others keep retrying', async () => {
    // WHY: the purge is per-position (row-level DELETE) — the old KV write-through rewrote the WHOLE set, so a
    // racy/partial write could silently drop the other still-pending retries.
    await store.removePending('OUR_A');
    expect([...(await store.loadPending())]).toEqual(['OUR_B']);
    await store.removePending('OUR_NEVER_ADDED'); // no-op, no throw
    expect([...(await store.loadPending())]).toEqual(['OUR_B']);
  });

  it('pending set is INDEPENDENT of the re-open-suppression set (distinct tables)', async () => {
    // WHY: rugExited (LEADER positions, suppress RE-OPEN) and rugExitPending (OUR positions, drive RE-CLOSE) are
    // separate concerns — persisting/purging one must never clobber the other.
    expect((await store.load()).has('OUR_B')).toBe(false);
    expect((await store.loadPending()).has('LEADER_A')).toBe(false);
  });

  it('pending rows are per-user (a stop/rug close of user #2 never drives a re-close for user #1)', async () => {
    const store2 = new RugExitStore(db, log, USER_2);
    await store2.addPending('OUR_ONLY_U2');
    expect((await store.loadPending()).has('OUR_ONLY_U2')).toBe(false);
    expect((await store2.loadPending()).has('OUR_ONLY_U2')).toBe(true);
  });
});

describe('RugExitStore — boot-seed reads FAIL LOUD, never a silent empty set (finding #152)', () => {
  it('a PERSISTENTLY failing loadPending() REJECTS after bounded retries — it never resolves to an empty set', async () => {
    // WHY (#152): loadPending seeds the rug-exit-PENDING set ONCE per runtime at boot. If it silently returned an
    // empty set on a saturated Postgres, createUserRuntime would seed a rug-exit-pending position as a NORMAL open
    // mirror — no sweep ever re-closes it and the position bleeds in the rugged pool. Failing LOUD makes
    // createUserRuntime reject, so the reload loop SKIPS the spawn and retries it next pass (locked in
    // user-reload.test.ts "per-user spawn isolation: u1's throwing spawn leaves NO half-entry") instead of booting a
    // runtime with a wrong empty set. This test FAILS if the read ever swallows the error and returns empty.
    const { db: down, state } = makeFlakyReadDb(db, Number.POSITIVE_INFINITY);
    await expect(new RugExitStore(down, log, USER).loadPending()).rejects.toThrow('db saturated');
    expect(state.calls).toBe(4); // RUG_EXIT_SEED_READ_RETRIES (3) + the initial attempt — the bounded retry ran
  });

  it('a PERSISTENTLY failing load() REJECTS too — the re-open-suppression seed is never silently empty', async () => {
    // WHY: symmetric to loadPending — a silently-empty re-open-suppression set would let the leader's next add
    // RE-ENTER a rug-exited position (bughunt finding #2). Both boot-seed reads must fail loud so the runtime is
    // deferred, never mis-seeded.
    const { db: down } = makeFlakyReadDb(db, Number.POSITIVE_INFINITY);
    await expect(new RugExitStore(down, log, USER).load()).rejects.toThrow('db saturated');
  });

  it('a TRANSIENT read that recovers within the retry budget seeds the REAL set (heals a saturated restart)', async () => {
    // WHY (#152 scenario, "Postgres briefly saturated on restart"): the bounded backoff must retry and HEAL to the
    // real durable set — a momentary hiccup neither drops the pending re-close nor defers the spawn unnecessarily.
    const freshDb = await newDb();
    await new RugExitStore(freshDb, log, USER).addPending('OUR_RECOVER');
    const { db: flaky, state } = makeFlakyReadDb(freshDb, 1); // one transient failure, then it recovers
    const recovered = await new RugExitStore(flaky, log, USER).loadPending();
    expect([...recovered]).toEqual(['OUR_RECOVER']); // healed to the REAL set — never a silent empty
    expect(state.calls).toBe(2); // 1 failure + 1 success — it STOPPED retrying the moment the read succeeded
  }, 20_000); // real-timer backoff + fresh-PGlite setup: generous timeout so full-suite CPU contention can't flake it

  it('a mid-run addPending WRITE failure stays FAIL-SAFE: logged, never thrown (in-memory still re-closes this run)', async () => {
    // WHY: the boot-seed READS fail loud (above), but a mid-run WRITE must NOT crash the live process — the
    // in-memory pending set still drives the re-close this run; only cross-restart durability is at risk (re-armed
    // by the next rug-SL/reconcile pass). This is the deliberate boot-seed-vs-mid-run split.
    const broken = {
      insert: () => {
        throw new Error('db down');
      },
    } as unknown as Database;
    await expect(
      new RugExitStore(broken, log, USER).addPending('OUR_MIDRUN'),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('purgeRugExitPending — close-confirm purge (ev:executed path + reconcile share it)', () => {
  it('★ a pending entry is PURGED on a confirmed close: memory AND the durable row, in one call', async () => {
    // WHY (Inc.3a deliverable 4): when the coffre confirms a close (ev:executed) for a position in the pending
    // set, the entry must go — before this, only the reconcile purged it, so an entry whose mirror was already
    // unregistered sat inert forever (and was re-seeded at every boot). "Entry gone" must hold across a restart.
    const freshDb = await newDb();
    const s = new RugExitStore(freshDb, log, USER);
    await s.addPending('OUR_CLOSING');
    const pending = await s.loadPending();
    expect(pending.has('OUR_CLOSING')).toBe(true);

    expect(await purgeRugExitPending(pending, s, 'OUR_CLOSING')).toBe(true); // the close-confirm hook
    expect(pending.has('OUR_CLOSING')).toBe(false); // in-memory: the reconcile stops re-closing NOW
    const rebooted = await new RugExitStore(freshDb, log, USER).loadPending();
    expect(rebooted.has('OUR_CLOSING')).toBe(false); // durable: not re-seeded at the next boot
  });

  it('a close-confirm for a position NOT in the pending set is a clean no-op (returns false, deletes nothing)', async () => {
    // WHY: every ordinary leader-close confirm flows through the same hook — it must not touch other entries.
    const freshDb = await newDb();
    const s = new RugExitStore(freshDb, log, USER);
    await s.addPending('OUR_OTHER');
    const pending = await s.loadPending();
    expect(await purgeRugExitPending(pending, s, 'OUR_UNRELATED')).toBe(false);
    expect((await s.loadPending()).has('OUR_OTHER')).toBe(true);
  });
});
