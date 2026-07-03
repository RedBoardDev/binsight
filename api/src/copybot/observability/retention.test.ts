/**
 * Retention policy + prune (#65). These tests encode the WHY: append-only tables must not grow forever, but the
 * prune must delete ONLY expendable rows — the user-facing feed, pinned alerts, and recent history are the durable
 * product record and MUST survive. A test that let a feed/pinned/recent row be deleted would be wrong.
 */
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { openDatabase } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { copyJournal, networthSnapshots } from '@/infrastructure/persistence/schema';
import {
  COPY_JOURNAL_INTERNAL_RETENTION_DAYS,
  NETWORTH_SNAPSHOT_RETENTION_DAYS,
  pruneOldRows,
  retentionCutoffs,
} from './retention';

const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as ReturnType<typeof openDatabase>;
})();

const NOW = 1_800_000_000_000; // fixed epoch-ms anchor for deterministic cutoffs
const DAY_MS = 86_400_000;

describe('retentionCutoffs — PURE cutoff math', () => {
  it('derives absolute epoch-ms cutoffs from the retention windows', () => {
    const c = retentionCutoffs(NOW);
    expect(c.copyJournalInternalBefore).toBe(NOW - COPY_JOURNAL_INTERNAL_RETENTION_DAYS * DAY_MS);
    expect(c.networthSnapshotBefore).toBe(NOW - NETWORTH_SNAPSHOT_RETENTION_DAYS * DAY_MS);
  });
});

function journalRow(over: {
  ts: number;
  audience: string | null;
  pinned: boolean | null;
  code: string;
}) {
  return {
    ts: over.ts,
    process: 'brain',
    stage: 'detect',
    outcome: 'detected',
    severity: 'info',
    wallet: 'WJ',
    audience: over.audience,
    pinned: over.pinned,
    code: over.code,
  };
}

describe('pruneOldRows — deletes only expendable rows', () => {
  it('prunes old internal non-pinned copy_journal rows; keeps feed, pinned, and recent', async () => {
    const c = retentionCutoffs(NOW);
    const old = c.copyJournalInternalBefore - 1000; // strictly past the cutoff
    const recent = c.copyJournalInternalBefore + 1000; // inside the window
    await db.insert(copyJournal).values([
      journalRow({ ts: old, audience: 'internal', pinned: false, code: 'old.internal' }), // DELETED
      journalRow({ ts: old, audience: 'internal', pinned: true, code: 'old.pinned' }), // kept (pinned alert)
      journalRow({ ts: old, audience: 'feed', pinned: false, code: 'old.feed' }), // kept (user feed)
      journalRow({ ts: recent, audience: 'internal', pinned: false, code: 'recent.internal' }), // kept (recent)
    ]);

    await pruneOldRows(db, NOW);

    const rows = await db.select().from(copyJournal).where(eq(copyJournal.wallet, 'WJ'));
    const codes = rows.map((r) => r.code).sort();
    expect(codes).toEqual(['old.feed', 'old.pinned', 'recent.internal']);
  });

  it('downsamples old networth_snapshots to one-per-UTC-day; leaves recent samples intact', async () => {
    const c = retentionCutoffs(NOW);
    const old = c.networthSnapshotBefore - 1000; // strictly past the cutoff
    const recent = c.networthSnapshotBefore + 1000; // inside the window
    const snap = (bucket: number, ts: number) => ({
      wallet: 'WN',
      bucket,
      ts,
      walletTotalSol: 1,
      tvlSol: 1,
      idleSol: 0,
    });
    // buckets 999940 & 999941 are the SAME UTC day (both floor(b/96) === 10416); both are old → keep the latest.
    await db
      .insert(networthSnapshots)
      .values([snap(999940, old), snap(999941, old), snap(1050000, recent)]);

    await pruneOldRows(db, NOW);

    const buckets = (
      await db.select().from(networthSnapshots).where(eq(networthSnapshots.wallet, 'WN'))
    )
      .map((r) => r.bucket)
      .sort((a, b) => a - b);
    expect(buckets).toEqual([999941, 1050000]); // 999940 (older twin) pruned; recent untouched
  });
});
