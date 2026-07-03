/**
 * Copy-bot · observability — RETENTION policy + prune job (#65).
 *
 * Several append-only tables grow forever: `copy_journal` gets a row for ~every detect/decide/sign/reconcile
 * step across BOTH processes (7 indexes maintained per write), and `networth_snapshots` adds 96 rows/wallet/day.
 * Left unbounded they balloon storage and slow every indexed read. This module locks a retention DECISION and a
 * small periodic prune that enforces it.
 *
 * Split: `retentionCutoffs(now)` is PURE (unit-testable cutoff math); `pruneOldRows(db, now)` is the I/O that runs
 * the DELETEs. What is KEPT is deliberate:
 *  - `copy_journal`: only `audience='internal'` NON-pinned rows past the cutoff are pruned. `audience='feed'` rows
 *    (the user-facing activity feed) and any `pinned` row (a critical-after-retries alert) are kept forever — they
 *    are the durable product record, not debug telemetry.
 *  - `networth_snapshots`: past the cutoff the 15-min series is DOWNSAMPLED to one sample per UTC day (the latest
 *    in each day survives) — enough to draw a long-range curve without keeping 96 points/day/wallet indefinitely.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { copyJournal, networthSnapshots } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

// TODO(#65 wiring): schedule `pruneOldRows(db, Date.now())` on a periodic timer next to the other brain jobs in
// `src/copybot/brain/brain-main.ts` (the `setInterval` block ~L549-578, e.g. a `PRUNE_MS = 6 * 60 * 60 * 1000`
// daily-ish cadence with a `.catch()` like `feeSweep`). Left un-wired here because brain-main.ts is owned by
// another agent / outside this change's file scope.

/** Suggested prune cadence for the periodic wiring (see the TODO above): a few hours is ample for append-only tables. */
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Epoch-ms in one day — the unit for every retention window below. */
const DAY_MS = 86_400_000;

/** Keep `audience='internal'` debug rows only this long: recent-incident triage rarely needs deeper history. */
export const COPY_JOURNAL_INTERNAL_RETENTION_DAYS = 30;

/** Keep the full 15-min net-worth series this long; older samples are downsampled to one point per UTC day. */
export const NETWORTH_SNAPSHOT_RETENTION_DAYS = 365;

/** `networth_snapshots.bucket` is a 15-min bucket (900 s); 96 of them span one UTC day → day = floor(bucket/96). */
const NETWORTH_BUCKETS_PER_DAY = 96;

/** Absolute epoch-ms cutoffs derived from `now`. Rows strictly OLDER than a cutoff are subject to its policy. */
export interface RetentionCutoffs {
  /** `copy_journal` internal non-pinned rows with `ts` before this are pruned. */
  copyJournalInternalBefore: number;
  /** `networth_snapshots` with `ts` before this are downsampled to one-per-UTC-day. */
  networthSnapshotBefore: number;
}

/** PURE: turn the retention windows into absolute epoch-ms cutoffs relative to `now`. */
export function retentionCutoffs(now: number): RetentionCutoffs {
  return {
    copyJournalInternalBefore: now - COPY_JOURNAL_INTERNAL_RETENTION_DAYS * DAY_MS,
    networthSnapshotBefore: now - NETWORTH_SNAPSHOT_RETENTION_DAYS * DAY_MS,
  };
}

/**
 * I/O: enforce {@link retentionCutoffs} with two bounded DELETEs. Idempotent (re-running deletes nothing new) and
 * safe to run periodically. Deletes only expendable rows — see the module header for exactly what is KEPT.
 */
export async function pruneOldRows(db: Db, now: number): Promise<void> {
  const cutoffs = retentionCutoffs(now);

  // 1) copy_journal: drop internal, NON-pinned rows past the cutoff; keep feed rows and every pinned alert.
  await db
    .delete(copyJournal)
    .where(
      and(
        eq(copyJournal.audience, 'internal'),
        lt(copyJournal.ts, cutoffs.copyJournalInternalBefore),
        sql`coalesce(${copyJournal.pinned}, false) = false`,
      ),
    );

  // 2) networth_snapshots: downsample past the cutoff to one sample per (wallet, UTC day) — keep the LATEST bucket
  // of each day, delete the rest. Integer division `bucket / 96` groups the 15-min buckets into UTC days.
  await db.execute(sql`
    DELETE FROM ${networthSnapshots} AS ns
    WHERE ns.ts < ${cutoffs.networthSnapshotBefore}
      AND ns.bucket <> (
        SELECT max(ns2.bucket) FROM ${networthSnapshots} AS ns2
        WHERE ns2.wallet = ns.wallet
          AND (ns2.bucket / ${NETWORTH_BUCKETS_PER_DAY}) = (ns.bucket / ${NETWORTH_BUCKETS_PER_DAY})
      )
  `);
}
