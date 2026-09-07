import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import type { Mirror } from './mirror-registry';
import { MirrorStore } from './mirror-store';

// Fresh in-memory Postgres (PGlite) with the real Drizzle migrations applied — the multi-tenant copy_positions
// PK (user_id, leader_position) is exercised exactly as production creates it.
const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();

const USER = 'test-user-1';
const USER_2 = 'test-user-2';
const LP = '__test_mirror_store__';
const mirror: Mirror = {
  leaderPosition: LP,
  leaderAddress: 'LEADER_A',
  ourPosition: 'OUR',
  pool: 'POOL',
  nonSolSymbol: 'TOK',
  nonSolMint: 'MINT_A',
  sizeSol: 0.25,
  lowerBin: -45,
  upperBin: -42,
  openedAt: 1_700_000_000_000,
  status: 'open',
};

const store = new MirrorStore(db, USER);

describe('MirrorStore — no-dormant persistence, per user', () => {
  it('saveOpen → loadOpen returns the mirror', async () => {
    await store.saveOpen(mirror);
    const open = await store.loadOpen();
    expect(open.find((m) => m.leaderPosition === LP)).toMatchObject({
      ourPosition: 'OUR',
      lowerBin: -45,
      status: 'open',
    });
  });

  it('round-trips leaderAddress — the mirror→leader mapping survives a restart (3b per-leader ops)', async () => {
    // WHY: per-leader stop-closes, per-leader exposure caps and per-leader rug-SL config all resolve from
    // m.leaderAddress. If it did not survive a restart, a stop of leader A after a reboot could close (or spare)
    // the WRONG leader's mirrors.
    const fresh = new MirrorStore(db, USER);
    expect((await fresh.loadOpen()).find((m) => m.leaderPosition === LP)?.leaderAddress).toBe(
      'LEADER_A',
    );
  });

  it("legacy pre-3b row (leader NULL) loads with leaderAddress '' → planStopCloses treats it as STOPPED", async () => {
    // WHY: '' matches no real leader address, so isStarted(prev, '') is false → a per-leader stop transition
    // never force-closes a row whose leader we cannot know; only a GLOBAL stop does. Loading anything else
    // (e.g. cfg.leader) could close a legacy mirror on an unrelated leader's stop.
    const LEGACY_LP = '__test_legacy_null_leader__';
    await db.insert(schema.copyPositions).values({
      userId: USER,
      leaderPosition: LEGACY_LP,
      leader: null, // a row written before the 3b `leader` column existed
      ourPosition: 'OUR_LEGACY',
      pool: 'POOL',
      nonSolSymbol: 'TOK',
      sizeSol: 0.1,
      lowerBin: -1,
      upperBin: 1,
      status: 'open',
      openedAt: 1_700_000_000_000,
      closedAt: null,
    });
    const open = await store.loadOpen();
    expect(open.find((m) => m.leaderPosition === LEGACY_LP)?.leaderAddress).toBe('');
  });

  it('RESTART SIMULATION: a NEW store bound to the same user reloads the open mirror (survives a restart)', async () => {
    const fresh = new MirrorStore(db, USER); // ≈ restarted process: no memory
    const open = await fresh.loadOpen();
    expect(open.some((m) => m.leaderPosition === LP)).toBe(true); // no dormant position lost
  });

  it('★ user #2 can mirror the SAME leader position — its row is NOT swallowed by user #1 (SPEC §11)', async () => {
    // WHY (the user-#2-collision bug class): with a leader_position-only PK, user #2's saveOpen conflicts with
    // user #1's row and onConflictDoNothing silently DROPS it — user #2's mirror would be lost (a dormant,
    // untracked real-money position after a restart). The composite PK makes both rows coexist.
    const store2 = new MirrorStore(db, USER_2);
    await store2.saveOpen({ ...mirror, ourPosition: 'OUR_2', sizeSol: 0.75 });
    const open2 = await store2.loadOpen();
    expect(open2.find((m) => m.leaderPosition === LP)).toMatchObject({ ourPosition: 'OUR_2' });
    // …and user #1 still loads ITS own mirror, not user #2's:
    expect((await store.loadOpen()).find((m) => m.leaderPosition === LP)).toMatchObject({
      ourPosition: 'OUR',
    });
  });

  it('updateSize persists the new SOL size for THIS user only (the effective ratio survives a restart)', async () => {
    // WHY: after a proportional add/remove the tracked size changes; if it were not persisted, a restart would
    // reload the STALE open size and mis-size future mirror actions. Scoped per user: resizing user #1's mirror
    // must never touch user #2's row for the same leader position.
    await store.updateSize(LP, 0.5);
    const reloaded = (await new MirrorStore(db, USER).loadOpen()).find(
      (m) => m.leaderPosition === LP,
    );
    expect(reloaded?.sizeSol).toBe(0.5);
    const other = (await new MirrorStore(db, USER_2).loadOpen()).find(
      (m) => m.leaderPosition === LP,
    );
    expect(other?.sizeSol).toBe(0.75); // untouched
  });

  it('round-trips nonSolMint — the per-token concurrency-cap key survives a restart (ULTRACODE #9)', async () => {
    // WHY: maxConcurrentPerToken counts open mirrors by their token mint. If the mint did not survive a restart,
    // the cap would silently under-count after a reboot and could over-open into the same token.
    const MINT_LP = '__test_mirror_mint__';
    await store.saveOpen({
      ...mirror,
      leaderPosition: MINT_LP,
      ourPosition: 'OUR_MINT',
      nonSolMint: 'MintABC',
    });
    const reloaded = (await new MirrorStore(db, USER).loadOpen()).find(
      (m) => m.leaderPosition === MINT_LP,
    );
    expect(reloaded?.nonSolMint).toBe('MintABC');
  });

  it("legacy row (non_sol_mint NULL) loads with nonSolMint '' → never counted toward the per-token cap", async () => {
    // WHY: a row written before the non_sol_mint column has NULL; '' matches no real candidate mint, so such a
    // mirror is simply not counted (safe). Loading it as null/undefined would break the string-equality count.
    const LEGACY_MINT_LP = '__test_legacy_null_mint__';
    await db.insert(schema.copyPositions).values({
      userId: USER,
      leaderPosition: LEGACY_MINT_LP,
      leader: 'LEADER_A',
      ourPosition: 'OUR_LEGACY_MINT',
      pool: 'POOL',
      nonSolSymbol: 'TOK',
      nonSolMint: null, // a row written before the non_sol_mint column existed
      sizeSol: 0.1,
      lowerBin: -1,
      upperBin: 1,
      status: 'open',
      openedAt: 1_700_000_000_000,
      closedAt: null,
    });
    const loaded = (await store.loadOpen()).find((m) => m.leaderPosition === LEGACY_MINT_LP);
    expect(loaded?.nonSolMint).toBe('');
  });

  it('markClosed closes THIS user mirror only → user #2 same-leader mirror stays open', async () => {
    // WHY: a close keyed by leader_position alone would close BOTH tenants' mirrors — user #2's copy would be
    // marked closed in the DB while still open on-chain (a dormant position after a restart).
    await store.markClosed(LP);
    expect((await store.loadOpen()).some((m) => m.leaderPosition === LP)).toBe(false);
    expect(
      (await new MirrorStore(db, USER_2).loadOpen()).some((m) => m.leaderPosition === LP),
    ).toBe(true);
  });

  it('★ re-open over a force-closed row REWRITES it to open — no untracked funded position (finding #45/#63)', async () => {
    // WHY (the stop→re-enable bug class): a user stops copying → we force-close OUR row (status='closed') while the
    // LEADER's position stays open on-chain. The user re-enables and the leader adds liquidity → the brain opens a
    // fresh copy and calls saveOpen for the SAME (userId, leaderPosition). With onConflictDoNothing that save would
    // no-op on the PK conflict, leaving the funded on-chain copy hidden under the stale 'closed' row: loadOpen skips
    // it at boot → an UNTRACKED money position, the leader's eventual close mirrored late (global orphan pass only),
    // fee/journal attribution lost. The upsert must REWRITE the row back to 'open' with the fresh open's fields.
    const REOPEN_LP = '__test_reopen_after_close__';
    await store.saveOpen({ ...mirror, leaderPosition: REOPEN_LP, ourPosition: 'OUR_FIRST' });
    await store.markClosed(REOPEN_LP); // user stopped → our row force-closed while the leader stays open on-chain
    expect((await store.loadOpen()).some((m) => m.leaderPosition === REOPEN_LP)).toBe(false); // stale closed row

    // Re-enable + leader adds liquidity → fresh copy opened; saveOpen must revive the row (different fields prove a
    // real rewrite, not just a status flip).
    await store.saveOpen({
      ...mirror,
      leaderPosition: REOPEN_LP,
      ourPosition: 'OUR_REOPEN',
      sizeSol: 0.9,
    });
    const reopened = (await new MirrorStore(db, USER).loadOpen()).find(
      (m) => m.leaderPosition === REOPEN_LP,
    ); // fresh store ≈ restarted process → also proves the revived row survives a restart (no-dormant)
    expect(reopened).toMatchObject({ status: 'open', ourPosition: 'OUR_REOPEN', sizeSol: 0.9 });
  });

  it('saveOpen of the SAME open twice is idempotent — exactly one row, fields intact (no PK-conflict corruption)', async () => {
    // WHY: the open path may re-run saveOpen for an already-persisted mirror (registry admits at most ONE live
    // mirror per (userId, leaderPosition)); a second save must not throw and must leave exactly one row with the
    // same fields — never a duplicate nor a partially-rewritten row.
    const IDEMPOTENT_LP = '__test_saveopen_idempotent__';
    const twice: Mirror = { ...mirror, leaderPosition: IDEMPOTENT_LP, ourPosition: 'OUR_IDEMP' };
    await store.saveOpen(twice);
    await store.saveOpen(twice); // same open again → onConflictDoUpdate rewrites identical values (no-op effect)

    const rows = await db
      .select()
      .from(schema.copyPositions)
      .where(
        and(
          eq(schema.copyPositions.userId, USER),
          eq(schema.copyPositions.leaderPosition, IDEMPOTENT_LP),
        ),
      );
    expect(rows).toHaveLength(1); // composite PK holds → exactly one row, never a duplicate
    const loaded = (await store.loadOpen()).find((m) => m.leaderPosition === IDEMPOTENT_LP);
    expect(loaded).toMatchObject({ status: 'open', ourPosition: 'OUR_IDEMP', sizeSol: 0.25 });
  });
});
