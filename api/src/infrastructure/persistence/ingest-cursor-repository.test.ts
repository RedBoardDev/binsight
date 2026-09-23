import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from './database';
import { PostgresIngestCursorRepository } from './ingest-cursor-repository';
import * as schema from './schema';

async function newRepo(): Promise<PostgresIngestCursorRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new PostgresIngestCursorRepository(db as unknown as Database);
}

// One cursor now describes what legs, cash-flows and swap legs have all read (they are decoded from the
// same pagination). The flow and swap cursor tables were always written identical to it and are gone.
describe('PostgresIngestCursorRepository', () => {
  // WHY: the cursor is the incremental-ingest resume state (page newest→genesis, top-up to newestSig);
  // it must round-trip so a restart resumes instead of re-paging the whole history.
  it('round-trips the cursor and overwrites it in place', async () => {
    const repo = await newRepo();
    expect(await repo.get('w')).toBeNull();
    await repo.set('w', { oldestSig: 'old', newestSig: 'new', complete: false });
    expect(await repo.get('w')).toEqual({ oldestSig: 'old', newestSig: 'new', complete: false });
    await repo.set('w', { oldestSig: 'older', newestSig: 'newer', complete: true });
    expect(await repo.get('w')).toEqual({ oldestSig: 'older', newestSig: 'newer', complete: true });
  });

  // WHY: a first page that failed leaves a cursor with no signatures at all; the ingest must be able to
  // read that state back as-is to treat the next run as a fresh backfill.
  it('stores a signature-less cursor', async () => {
    const repo = await newRepo();
    await repo.set('w', { oldestSig: null, newestSig: null, complete: false });
    expect(await repo.get('w')).toEqual({ oldestSig: null, newestSig: null, complete: false });
  });

  it('is scoped per wallet', async () => {
    const repo = await newRepo();
    await repo.set('w1', { oldestSig: 'a', newestSig: 'b', complete: true });
    expect(await repo.get('w2')).toBeNull();
  });

  // WHY: gates the PnL curve's "indexing…" state and the realized pass across a whole scope in one COUNT.
  it('allComplete is true only when EVERY wallet has a complete cursor; missing/partial → false; [] → true', async () => {
    const repo = await newRepo();
    const cur = (complete: boolean) => ({ oldestSig: 'g', newestSig: 'n', complete });
    await repo.set('w1', cur(true));
    await repo.set('w2', cur(false));
    expect(await repo.allComplete([])).toBe(true);
    expect(await repo.allComplete(['w1'])).toBe(true);
    expect(await repo.allComplete(['w1', 'w2'])).toBe(false); // w2 not complete
    expect(await repo.allComplete(['w1', 'w3'])).toBe(false); // w3 has no cursor row
    await repo.set('w2', cur(true));
    expect(await repo.allComplete(['w1', 'w2'])).toBe(true);
  });
});
