import { eq, inArray } from 'drizzle-orm';
import type { Database } from './database';
import { walletRealized } from './schema';

/**
 * Stores the half of a wallet's realized PnL that belongs to no position — see {@link RealizedPnlResult}.
 * One row per wallet, rewritten by each realized pass. It is a derived scalar, not a ledger: recomputing
 * it costs the whole FIFO walk (every leg + every swap), which is far too expensive to run per request.
 */
export class WalletRealizedRepository {
  constructor(private readonly db: Database) {}

  /** Persist a wallet's non-position realized PnL (idempotent overwrite). */
  async set(wallet: string, tradingPnlSol: number): Promise<void> {
    await this.db
      .insert(walletRealized)
      .values({ wallet, tradingPnlSol, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: walletRealized.wallet,
        set: { tradingPnlSol, updatedAt: Date.now() },
      });
  }

  /** Summed non-position realized PnL for a set of wallets (0 for wallets never computed). */
  async sumFor(wallets: string[]): Promise<number> {
    if (wallets.length === 0) return 0;
    const rows = await this.db
      .select({ v: walletRealized.tradingPnlSol })
      .from(walletRealized)
      .where(inArray(walletRealized.wallet, wallets));
    return rows.reduce((a, r) => a + (r.v ?? 0), 0);
  }

  async get(wallet: string): Promise<number | null> {
    const [row] = await this.db
      .select({ v: walletRealized.tradingPnlSol })
      .from(walletRealized)
      .where(eq(walletRealized.wallet, wallet));
    return row?.v ?? null;
  }
}
