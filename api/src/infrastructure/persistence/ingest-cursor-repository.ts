import { and, eq, inArray, sql } from 'drizzle-orm';
import type { IngestCursor } from '@/domain/dlmm';
import type { IngestCursorStore } from '@/domain/ports';
import type { Database } from './database';
import { dlmmIngestCursor } from './schema';

/**
 * The wallet's ONE transaction-ingest cursor. Legs, cash-flows and swap legs are decoded from the same
 * pagination, so one position in the signature history describes what all three have read — it gates
 * the realized-PnL pass (swaps complete) and the PnL curve's "indexing…" state (flows complete) alike.
 */
export class PostgresIngestCursorRepository implements IngestCursorStore {
  constructor(private readonly db: Database) {}

  async get(wallet: string): Promise<IngestCursor | null> {
    const [row] = await this.db
      .select()
      .from(dlmmIngestCursor)
      .where(eq(dlmmIngestCursor.wallet, wallet));
    return row
      ? { oldestSig: row.oldestSig, newestSig: row.newestSig, complete: row.complete }
      : null;
  }

  async set(wallet: string, cursor: IngestCursor): Promise<void> {
    const values = { ...cursor, updatedAt: Date.now() };
    await this.db
      .insert(dlmmIngestCursor)
      .values({ wallet, ...values })
      .onConflictDoUpdate({ target: dlmmIngestCursor.wallet, set: values });
  }

  /** True iff every wallet's history has been read to genesis — one COUNT, not N lookups. A wallet with
   *  no cursor yet (still backfilling) correctly fails it. */
  async allComplete(wallets: string[]): Promise<boolean> {
    if (wallets.length === 0) return true;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(dlmmIngestCursor)
      .where(and(inArray(dlmmIngestCursor.wallet, wallets), eq(dlmmIngestCursor.complete, true)));
    return Number(row?.n ?? 0) === wallets.length;
  }
}
