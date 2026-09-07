import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { CopybotPositionsRepository } from './copybot-positions-repository';
import type { Database } from './database';
import * as schema from './schema';
import { copyPositions } from './schema';

// Fresh in-memory Postgres (PGlite) with the real Drizzle migrations applied — the multi-tenant copy_positions
// table (status + user_id) is exercised exactly as production creates it.
async function setup() {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: './drizzle' });
  const db = pg as unknown as Database;
  return { db, repo: new CopybotPositionsRepository(db) };
}

// A copy_positions row where only user_id / leader_position / status / size_sol matter to these tests; the rest
// carry inert-but-valid defaults so the NOT NULL columns are satisfied exactly as a real mirror write is.
function row(userId: string, leaderPosition: string, status: 'open' | 'closed', sizeSol = 0.1) {
  return {
    userId,
    leaderPosition,
    leader: 'LEADER_A',
    ourPosition: `our:${userId}:${leaderPosition}`,
    pool: 'POOL',
    nonSolSymbol: 'TOK',
    nonSolMint: 'MINT',
    sizeSol,
    lowerBin: -1,
    upperBin: 1,
    status,
    openedAt: 1_700_000_000_000,
    closedAt: status === 'closed' ? 1_700_000_001_000 : null,
  };
}

describe('CopybotPositionsRepository.listUserIdsWithOpenMirrors — boot/reload spawn UNION (finding #134)', () => {
  it('returns DISTINCT tenants holding ≥1 OPEN mirror, and NONE whose mirrors are all closed', async () => {
    // WHY (the forbidden missed close): this set is the never-miss backstop. A user STOPPED while the brain was
    // down is enabled:false — absent from the active-user list — yet their live positions sit on-chain; they MUST
    // be re-spawned to drain. A user with only closed rows must NOT be spawned (nothing to drain), and a user with
    // several open mirrors must appear exactly ONCE (spawned once, not per-mirror).
    const { db, repo } = await setup();
    await db.insert(copyPositions).values([
      row('u-open', 'lpA', 'open'),
      row('u-open', 'lpB', 'open'), // same tenant, two open mirrors → must dedup to a single id
      row('u-mixed', 'lpC', 'open'), // one open, one closed → still counts (it has an open row)
      row('u-mixed', 'lpD', 'closed'),
      row('u-closed', 'lpE', 'closed'), // fully drained → excluded
    ]);
    const ids = await repo.listUserIdsWithOpenMirrors();
    expect([...ids].sort()).toEqual(['u-mixed', 'u-open']);
  });

  it('an empty table (fresh DB / every mirror already drained) yields no spawns', async () => {
    const { repo } = await setup();
    expect(await repo.listUserIdsWithOpenMirrors()).toEqual([]);
  });
});

describe('CopybotPositionsRepository — per-tenant OPEN projections (teardown gate / withdraw)', () => {
  it("openMirrorCount counts ONLY this tenant's open rows", async () => {
    const { db, repo } = await setup();
    await db.insert(copyPositions).values([
      row('u1', 'lpA', 'open'),
      row('u1', 'lpB', 'open'),
      row('u1', 'lpC', 'closed'), // closed → not counted
      row('u2', 'lpD', 'open'), // other tenant → must not leak in
    ]);
    expect(await repo.openMirrorCount('u1')).toBe(2);
    expect(await repo.openMirrorCount('nobody')).toBe(0);
  });

  it("deployedSol sums size_sol over this tenant's OPEN rows only", async () => {
    const { db, repo } = await setup();
    await db.insert(copyPositions).values([
      row('u1', 'lpA', 'open', 0.25),
      row('u1', 'lpB', 'open', 0.75),
      row('u1', 'lpC', 'closed', 5), // closed → excluded from deployed capital
    ]);
    expect(await repo.deployedSol('u1')).toBeCloseTo(1.0);
    expect(await repo.deployedSol('nobody')).toBe(0);
  });
});

describe('CopybotPositionsRepository.listClosedWithoutFee — #140 fee no-miss backstop query', () => {
  it('returns CLOSED + booted + UN-FEED positions past the grace; excludes open / already-feed / non-booted', async () => {
    // WHY: the backstop must assess exactly the positions the sell-confirm path missed — a CLOSED position (owned by
    // a booted runtime) with NO fee_ledger row. An open position owes nothing yet; an already-feed one must be
    // ANTI-JOINED out (never double-charged); another tenant's row is out unless its runtime is booted.
    const { db, repo } = await setup();
    await db.insert(copyPositions).values([
      row('u1', 'lpOpen', 'open'), // open → owes nothing yet
      row('u1', 'lpNoFee', 'closed'), // closed, no fee row → INCLUDED
      row('u1', 'lpFeed', 'closed'), // closed, HAS a fee row → anti-joined out
      row('u2', 'lpOther', 'closed'), // closed but u2 not booted → out
    ]);
    await db.insert(schema.feeLedger).values({
      userId: 'u1',
      ourPosition: 'our:u1:lpFeed',
      basePnlLamports: 1,
      feeLamports: 1,
      state: 'pending',
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    // The `row` helper stamps closedAt = 1_700_000_001_000; a threshold AFTER it clears the grace for all closed rows.
    const rows = await repo.listClosedWithoutFee(['u1'], 25, 1_700_000_002_000);
    expect(rows).toEqual([{ userId: 'u1', ourPosition: 'our:u1:lpNoFee' }]);
  });

  it('a position closed WITHIN the grace (closedAt ≥ closedBeforeMs) is NOT returned; once the grace elapses it is', async () => {
    // WHY: the grace lets a normal close-sell's EXACT assess (onSellConfirmed) win first; only after it lapses does
    // the backstop take over — so a slow-but-successful sell is never pre-empted by a premature, sell-less assess.
    const { db, repo } = await setup();
    await db.insert(copyPositions).values([row('u1', 'lpFresh', 'closed')]); // closedAt = 1_700_000_001_000
    expect(await repo.listClosedWithoutFee(['u1'], 25, 1_700_000_000_500)).toEqual([]); // still within grace
    expect(await repo.listClosedWithoutFee(['u1'], 25, 1_700_000_002_000)).toEqual([
      { userId: 'u1', ourPosition: 'our:u1:lpFresh' },
    ]); // grace elapsed → now actionable
  });

  it('no booted runtimes → empty (nothing actionable this pass; never a full-table scan)', async () => {
    const { db, repo } = await setup();
    await db.insert(copyPositions).values([row('u1', 'lp', 'closed')]);
    expect(await repo.listClosedWithoutFee([], 25, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});
