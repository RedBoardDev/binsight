import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from './database';
import { feeLedger } from './schema';

/** A fee owed on a closed position, as the feeSweep picks it up (Inc.4d, SPEC §9). */
export interface PendingFee {
  userId: string;
  ourPosition: string;
  feeLamports: number;
  attempts: number;
}

/** The lifecycle states of a fee row: owed & sweepable | collected on-chain | recorded-but-no-sink. */
export type FeeState = 'pending' | 'landed' | 'skipped';

/**
 * The per-position performance-fee ledger (Inc.4d). The brain ASSESSES one row per closed position (idempotent),
 * the periodic feeSweep publishes a transfer for each `pending` row until it LANDS, and each has an `attempts`
 * counter for per-attempt journaling. One owner of the `fee_ledger` table.
 */
export class FeeLedgerRepository {
  constructor(private readonly db: Database) {}

  /**
   * Record the fee owed for a closed position, idempotent on `(user_id, our_position)` — a re-confirm / reconcile
   * double-fire never double-assesses. Returns `true` only when a NEW row was inserted (so the caller emits the
   * transparency feed event exactly once). `state` is 'pending' when a sink is configured, else 'skipped'.
   */
  async assess(
    userId: string,
    ourPosition: string,
    basePnlLamports: number,
    feeLamports: number,
    state: FeeState,
  ): Promise<boolean> {
    const now = Date.now();
    const inserted = await this.db
      .insert(feeLedger)
      .values({
        userId,
        ourPosition,
        basePnlLamports,
        feeLamports,
        state,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: feeLedger.id });
    return inserted.length > 0;
  }

  /**
   * The oldest `pending` fees OWNED BY A CURRENTLY-BOOTED RUNTIME, bounded — the feeSweep publishes a transfer for
   * each (SPEC §9). Filtering to booted users at the SOURCE stops un-bootable fees (a user deactivated before its
   * fee swept and never respawned) from permanently occupying the bounded batch and head-of-line-blocking live
   * users' fees (finding #155). The bound is applied AFTER the filter, so a live user's fee is never starved.
   */
  async listPending(bootedUserIds: string[], limit: number): Promise<PendingFee[]> {
    if (bootedUserIds.length === 0) return []; // no runtime booted → no actionable fee this sweep
    return this.db
      .select({
        userId: feeLedger.userId,
        ourPosition: feeLedger.ourPosition,
        feeLamports: feeLedger.feeLamports,
        attempts: feeLedger.attempts,
      })
      .from(feeLedger)
      .where(and(eq(feeLedger.state, 'pending'), inArray(feeLedger.userId, bootedUserIds)))
      .orderBy(asc(feeLedger.createdAt))
      .limit(limit);
  }

  /**
   * DISTINCT user_ids that still owe a 'pending' fee. The boot/reload spawn UNION reads this (finding #3) so a user
   * who STOPPED with a pending performance fee — no open mirror ⇒ absent from BOTH listActiveUserIds and
   * listUserIdsWithOpenMirrors — is still spawned (drained / fee-sweep-only) and the operator collects that fee.
   * Complements listPending's booted-only filter (#155): that filter stops un-bootable fees from head-of-line-
   * blocking the bounded batch; this makes those users bootable so the pending fee actually drains. Mirrors
   * CopybotPositionsRepository.listUserIdsWithOpenMirrors — a spawn KEY (each owner once), not a per-fee list.
   */
  async listUserIdsWithPendingFees(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: feeLedger.userId })
      .from(feeLedger)
      .where(eq(feeLedger.state, 'pending'));
    return rows.map((r) => r.userId);
  }

  /** Count a publish attempt for a pending fee (per-attempt journaling; the row stays pending until it lands). */
  async bumpAttempts(userId: string, ourPosition: string): Promise<void> {
    const row = await this.db
      .select({ attempts: feeLedger.attempts })
      .from(feeLedger)
      .where(and(eq(feeLedger.userId, userId), eq(feeLedger.ourPosition, ourPosition)));
    const current = row[0]?.attempts ?? 0;
    await this.db
      .update(feeLedger)
      .set({ attempts: current + 1, updatedAt: Date.now() })
      .where(and(eq(feeLedger.userId, userId), eq(feeLedger.ourPosition, ourPosition)));
  }

  /**
   * Mark a fee collected once its transfer confirms — flips 'pending' → 'landed' (records the sig). Idempotent:
   * a second confirm no-ops (only a still-'pending' row transitions). Returns the collected `feeLamports` on the
   * transition (so the caller can render the amount in the feed), or `null` when nothing transitioned.
   */
  async markLanded(userId: string, ourPosition: string, sig: string): Promise<number | null> {
    const changed = await this.db
      .update(feeLedger)
      .set({ state: 'landed', sig, updatedAt: Date.now() })
      .where(
        and(
          eq(feeLedger.userId, userId),
          eq(feeLedger.ourPosition, ourPosition),
          eq(feeLedger.state, 'pending'),
        ),
      )
      .returning({ feeLamports: feeLedger.feeLamports });
    return changed[0]?.feeLamports ?? null;
  }
}
