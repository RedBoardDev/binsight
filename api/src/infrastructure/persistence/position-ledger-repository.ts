import { and, eq } from 'drizzle-orm';
import type { Database } from './database';
import { positionLedger } from './schema';

/** One appended execution-ledger movement (owner lamport delta for a confirmed position tx — SPEC §9). */
export interface PositionLedgerRow {
  userId: string;
  ourPosition: string;
  kind: string; // open | add | remove | close | claim
  lamportsIn: number; // SOL returned to the owner (positive delta)
  lamportsOut: number; // SOL the owner deposited (negative delta)
  sig: string;
  confirmedAt: number;
}

/**
 * The bot's own per-position execution ledger (Inc.4d). The confirm worker APPENDS one lamport-exact row per
 * confirmed position tx (post-confirm bookkeeping, off the exactly-once path); the brain READS a position's rows
 * at close to compute the fee base. Both go through this single owner of the `position_ledger` table.
 */
export class PositionLedgerRepository {
  constructor(private readonly db: Database) {}

  /**
   * Append a ledger row, idempotent on `(user_id, sig, our_position)` — a re-confirm of the same tx is a no-op,
   * so the ledger never double-counts a movement (the fee base stays exact under re-delivery).
   */
  async append(row: PositionLedgerRow): Promise<void> {
    await this.db
      .insert(positionLedger)
      .values({
        userId: row.userId,
        ourPosition: row.ourPosition,
        kind: row.kind,
        lamportsIn: row.lamportsIn,
        lamportsOut: row.lamportsOut,
        sig: row.sig,
        confirmedAt: row.confirmedAt,
      })
      .onConflictDoNothing();
  }

  /** Every ledger movement recorded for one position — the input to `sumLedgerBase` (fee assessment at close). */
  async listForPosition(
    userId: string,
    ourPosition: string,
  ): Promise<Array<{ lamportsIn: number; lamportsOut: number }>> {
    return this.db
      .select({ lamportsIn: positionLedger.lamportsIn, lamportsOut: positionLedger.lamportsOut })
      .from(positionLedger)
      .where(and(eq(positionLedger.userId, userId), eq(positionLedger.ourPosition, ourPosition)));
  }
}
