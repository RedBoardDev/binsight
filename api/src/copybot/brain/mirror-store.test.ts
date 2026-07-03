import { PGlite } from '@electric-sql/pglite';
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
  ourPosition: 'OUR',
  pool: 'POOL',
  nonSolSymbol: 'TOK',
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

  it('markClosed closes THIS user mirror only → user #2 same-leader mirror stays open', async () => {
    // WHY: a close keyed by leader_position alone would close BOTH tenants' mirrors — user #2's copy would be
    // marked closed in the DB while still open on-chain (a dormant position after a restart).
    await store.markClosed(LP);
    expect((await store.loadOpen()).some((m) => m.leaderPosition === LP)).toBe(false);
    expect(
      (await new MirrorStore(db, USER_2).loadOpen()).some((m) => m.leaderPosition === LP),
    ).toBe(true);
  });
});
