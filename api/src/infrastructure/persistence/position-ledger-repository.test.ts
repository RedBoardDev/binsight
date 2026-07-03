/**
 * Copy-bot · Inc.4d — position-ledger persistence invariants (SPEC §9). These encode the WHY:
 *  - the ledger is the fee base's source of truth, so a movement must round-trip lamport-exact as a JS number;
 *  - APPEND is idempotent on (user, sig, position): the confirm worker may re-see the same tx (re-delivery), and a
 *    double-counted deposit/withdraw would corrupt the base → over/under-charge the user;
 *  - listForPosition is scoped to (user, position): another user's or another position's rows must never bleed in.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from './database';
import { PositionLedgerRepository } from './position-ledger-repository';
import * as schema from './schema';

async function newRepo(): Promise<PositionLedgerRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new PositionLedgerRepository(db as unknown as Database);
}

const row = (over: Partial<Parameters<PositionLedgerRepository['append']>[0]> = {}) => ({
  userId: 'U',
  ourPosition: 'POS',
  kind: 'close',
  lamportsIn: 0,
  lamportsOut: 0,
  sig: 'SIG',
  confirmedAt: 1_700_000_000_000,
  ...over,
});

describe('PositionLedgerRepository', () => {
  it('round-trips a movement as an exact JS number', async () => {
    const repo = await newRepo();
    await repo.append(row({ sig: 'S1', kind: 'open', lamportsOut: 1_000_000_000 }));
    const rows = await repo.listForPosition('U', 'POS');
    expect(rows).toEqual([{ lamportsIn: 0, lamportsOut: 1_000_000_000 }]);
    expect(typeof rows[0]?.lamportsOut).toBe('number');
  });

  it('APPEND is idempotent on (user, sig, position) — a re-confirm never double-counts', async () => {
    const repo = await newRepo();
    await repo.append(row({ sig: 'DUP', kind: 'close', lamportsIn: 1_500_000_000 }));
    await repo.append(row({ sig: 'DUP', kind: 'close', lamportsIn: 1_500_000_000 }));
    const rows = await repo.listForPosition('U', 'POS');
    expect(rows).toHaveLength(1); // the unique key collapsed the re-delivery
  });

  it('the SAME sig for a DIFFERENT position is a distinct row (per-position ledger)', async () => {
    const repo = await newRepo();
    await repo.append(row({ sig: 'SHARED', ourPosition: 'POS_A', lamportsIn: 10 }));
    await repo.append(row({ sig: 'SHARED', ourPosition: 'POS_B', lamportsIn: 20 }));
    expect(await repo.listForPosition('U', 'POS_A')).toEqual([{ lamportsIn: 10, lamportsOut: 0 }]);
    expect(await repo.listForPosition('U', 'POS_B')).toEqual([{ lamportsIn: 20, lamportsOut: 0 }]);
  });

  it('listForPosition is scoped by user AND position (no cross-tenant / cross-position bleed)', async () => {
    const repo = await newRepo();
    await repo.append(row({ userId: 'U1', ourPosition: 'P', sig: 'a', lamportsIn: 1 }));
    await repo.append(row({ userId: 'U2', ourPosition: 'P', sig: 'b', lamportsIn: 2 }));
    expect(await repo.listForPosition('U1', 'P')).toEqual([{ lamportsIn: 1, lamportsOut: 0 }]);
    expect(await repo.listForPosition('U2', 'P')).toEqual([{ lamportsIn: 2, lamportsOut: 0 }]);
  });
});
