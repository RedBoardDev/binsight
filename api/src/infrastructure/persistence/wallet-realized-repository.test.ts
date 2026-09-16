import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from './database';
import * as schema from './schema';
import { WalletRealizedRepository } from './wallet-realized-repository';

async function newRepo(): Promise<WalletRealizedRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new WalletRealizedRepository(db as unknown as Database);
}

describe('WalletRealizedRepository', () => {
  it('overwrites on re-write — each realized pass replaces the previous figure, never accumulates', async () => {
    // WHY: this is a derived scalar recomputed from the whole FIFO walk, not a ledger of increments.
    // Summing successive passes would inflate it without bound.
    const repo = await newRepo();
    await repo.set('w1', -11.8);
    await repo.set('w1', -12.5);
    expect(await repo.get('w1')).toBeCloseTo(-12.5, 9);
  });

  it('sums across a watchlist and treats a never-computed wallet as zero', async () => {
    const repo = await newRepo();
    await repo.set('w1', -11.8);
    await repo.set('w2', 3.2);
    expect(await repo.sumFor(['w1', 'w2'])).toBeCloseTo(-8.6, 9);
    // A wallet whose realized pass has never run must not make the total disappear.
    expect(await repo.sumFor(['w1', 'unknown'])).toBeCloseTo(-11.8, 9);
    expect(await repo.sumFor([])).toBe(0);
    expect(await repo.get('unknown')).toBeNull();
  });

  it('keeps negative values intact (the case that matters — hidden losses)', async () => {
    const repo = await newRepo();
    await repo.set('w1', -0.000001);
    expect(await repo.get('w1')).toBeCloseTo(-0.000001, 12);
  });
});
