import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────
 * Stats / analytics
 * ──────────────────────────────────────────────────────────────────────── */

export const StatsSchema = z.object({
  scope: z.string(),
  closedCount: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  winRate: z.number(),
  /** realized PnL of the CLOSED positions in scope. */
  totalPnlSol: z.number(),
  /**
   * Realized PnL on tokens the wallet bought and sold OUTSIDE any position — the other half of the same
   * FIFO walk that produces `totalPnlSol`. It has no position to attach to, so it used to be dropped and
   * the reported result was only the position side of what the wallet actually did. All-time per wallet
   * (a cost-basis chain cannot be windowed), so it is NOT filtered by the `since` query.
   */
  outsidePositionsPnlSol: z.number().default(0),
  todayPnlSol: z.number(),
  totalFeesSol: z.number(),
  totalVolumeSol: z.number(),
  /** mean deposit per closed position. */
  avgInvestedSol: z.number(),
  /** total realized PnL ÷ months spanned by the closed history. */
  avgMonthlyProfitSol: z.number(),
  /** mean realized PnL per closed position (expected value of a position). */
  expectedValueSol: z.number(),
  /** gross profit ÷ gross loss (>1 = a net-profitable system); 0 when there are no losing trades. */
  profitFactor: z.number(),
  avgDurationSeconds: z.number(),
  /** PnL aggregated by pair, best→worst. */
  byPair: z.array(
    z.object({
      pair: z.string(),
      /** Legacy SOL metric. Zero for non-SOL quotes; never summed across quote units. */
      pnlSol: z.number(),
      /** Native quote PnL for this pair. */
      pnlQuote: z.number().optional(),
      quoteSymbol: z.string().optional(),
      count: z.number().int(),
    }),
  ),
});
export type Stats = z.infer<typeof StatsSchema>;

/** Time bucket for the profit-history chart. */
export const BucketSchema = z.enum(['hour', 'day', 'week', 'month']);
export type Bucket = z.infer<typeof BucketSchema>;

/** One bar of the profit-history chart: realized PnL in the bucket + all-time running total. */
export const ProfitBucketSchema = z.object({
  t: z.number().int(),
  realized: z.number(),
  cumulative: z.number(),
});
export type ProfitBucket = z.infer<typeof ProfitBucketSchema>;
