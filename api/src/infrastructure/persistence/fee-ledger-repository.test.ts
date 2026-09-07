/**
 * Copy-bot · Inc.4d — fee-ledger persistence invariants (SPEC §9). These encode the WHY:
 *  - ASSESS is idempotent per (user, position): two close-confirms must produce ONE fee (a re-fire must never
 *    charge twice), and only the FIRST insert reports `true` so the transparency feed emits exactly once;
 *  - listPending returns only sweepable fees, oldest first (a 'skipped' no-sink row is never swept);
 *  - listPending is scoped to CURRENTLY-BOOTED users and bounded AFTER that filter, so a deactivated user's
 *    un-swept fee can never head-of-line-block a live user's fee out of the bounded batch (finding #155);
 *  - listUserIdsWithPendingFees returns DISTINCT pending-fee owners (the #3 spawn union that boots a stopped user
 *    so their fee is collected) — landed/skipped excluded, each owner once (it keys a runtime spawn, not a fee list);
 *  - markLanded flips pending → landed once (a duplicate ev:executed(fee) confirm must not re-report);
 *  - bumpAttempts records each publish try (per-attempt journaling), leaving the row retryable.
 */
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from './database';
import { FeeLedgerRepository } from './fee-ledger-repository';
import * as schema from './schema';
import { feeLedger } from './schema';

async function newRepo(): Promise<{ repo: FeeLedgerRepository; db: Database }> {
  const db = drizzle(new PGlite(), { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: './drizzle' });
  return { repo: new FeeLedgerRepository(db), db };
}

describe('FeeLedgerRepository', () => {
  it('ASSESS is idempotent per (user, position) — two confirms = one fee, reported once', async () => {
    const { repo } = await newRepo();
    expect(await repo.assess('U', 'POS', 1_000_000_000, 50_000_000, 'pending')).toBe(true);
    expect(await repo.assess('U', 'POS', 1_000_000_000, 50_000_000, 'pending')).toBe(false);
    const pending = await repo.listPending(['U'], 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ ourPosition: 'POS', feeLamports: 50_000_000, attempts: 0 });
  });

  it("listPending returns only 'pending' rows, oldest first (a 'skipped' no-sink row is never swept)", async () => {
    const { repo } = await newRepo();
    await repo.assess('U', 'OLD', 100, 5, 'pending');
    await repo.assess('U', 'NEW', 200, 10, 'pending');
    await repo.assess('U', 'NOSINK', 300, 15, 'skipped');
    const pending = await repo.listPending(['U'], 10);
    expect(pending.map((p) => p.ourPosition)).toEqual(['OLD', 'NEW']); // skipped excluded, oldest first
  });

  it("listPending excludes un-bootable users' fees and bounds AFTER the filter — a live user's newer fee is not head-of-line-blocked by older un-bootable rows (finding #155)", async () => {
    const { repo } = await newRepo();
    await repo.assess('GONE', 'OLD1', 100, 5, 'pending'); // oldest, owner has no booted runtime (never respawned)
    await repo.assess('GONE', 'OLD2', 100, 5, 'pending');
    await repo.assess('LIVE', 'NEW', 200, 10, 'pending'); // newest, owner is booted
    // Only 'LIVE' is booted; even a bound of 1 must surface the live fee, never the older un-bootable rows.
    const pending = await repo.listPending(['LIVE'], 1);
    expect(pending.map((p) => p.ourPosition)).toEqual(['NEW']); // un-bootable rows never occupy the bounded batch
  });

  it('listPending returns nothing when no runtime is booted — no actionable fee this sweep', async () => {
    const { repo } = await newRepo();
    await repo.assess('U', 'POS', 100, 5, 'pending');
    expect(await repo.listPending([], 10)).toEqual([]); // empty booted set → no query, no rows
  });

  it('listUserIdsWithPendingFees returns DISTINCT pending owners (landed/skipped excluded) — the #3 spawn union', async () => {
    // WHY (#3): the boot/reload spawn set unions these so a STOPPED user with a pending fee is booted fee-sweep-only
    // and the operator collects it. Only 'pending' owners count (a landed/skipped row must not resurrect a runtime),
    // and a user with several pending fees appears ONCE (it is a spawn KEY, not a per-fee list).
    const { repo } = await newRepo();
    await repo.assess('A', 'POS1', 100, 5, 'pending');
    await repo.assess('A', 'POS2', 100, 5, 'pending'); // same user, 2nd pending fee → still ONE id (distinct)
    await repo.assess('B', 'POS3', 100, 5, 'landed'); // already collected → excluded
    await repo.assess('C', 'POS4', 100, 5, 'skipped'); // no-sink → excluded
    await repo.assess('D', 'POS5', 100, 5, 'pending');
    const ids = await repo.listUserIdsWithPendingFees();
    expect([...ids].sort()).toEqual(['A', 'D']); // distinct owners with a 'pending' fee only
  });

  it('bumpAttempts increments and leaves the row pending (retryable)', async () => {
    const { repo } = await newRepo();
    await repo.assess('U', 'POS', 1000, 50, 'pending');
    await repo.bumpAttempts('U', 'POS');
    await repo.bumpAttempts('U', 'POS');
    const pending = await repo.listPending(['U'], 10);
    expect(pending[0]?.attempts).toBe(2);
    expect(pending).toHaveLength(1); // still pending → still retryable
  });

  it('markLanded flips pending → landed once, returning the collected fee (a duplicate confirm no-ops)', async () => {
    const { repo, db } = await newRepo();
    await repo.assess('U', 'POS', 1000, 50, 'pending');
    expect(await repo.markLanded('U', 'POS', 'FEESIG')).toBe(50); // returns the collected feeLamports
    expect(await repo.markLanded('U', 'POS', 'FEESIG')).toBeNull(); // already landed → idempotent no-op
    expect(await repo.listPending(['U'], 10)).toHaveLength(0); // no longer swept
    const [landed] = await db.select().from(feeLedger).where(eq(feeLedger.ourPosition, 'POS'));
    expect(landed).toMatchObject({ state: 'landed', sig: 'FEESIG' });
  });
});
