import { z } from 'zod';
import { OpenPositionSchema } from './positions';

/* ────────────────────────────────────────────────────────────────────────
 * Aggregated wallet/portfolio state (REST + WS snapshot)
 * ──────────────────────────────────────────────────────────────────────── */

export const PortfolioTotalsSchema = z.object({
  uPnlSol: z.number(),
  uPnlPct: z.number(),
  feesSol: z.number(),
  claimedFeesSol: z.number(),
  unclaimedFeesSol: z.number(),
  tvlSol: z.number(),
  /** Idle wallet capital in SOL: native SOL + wSOL + stables (USDC/USDT) converted. */
  idleSol: z.number(),
  /** Known priced total. When valuationStatus is 'partial' this is an explicit LOWER BOUND, not an
   * exact figure: a held asset had no price source and was counted as zero rather than guessed. */
  walletTotalSol: z.number(),
  /** Price coverage of the wallet read. Defaults keep older persisted/native payloads decodable. */
  valuationStatus: z.enum(['complete', 'partial']).default('complete'),
  openCount: z.number().int(),
  inRangeCount: z.number().int(),
  outOfRangeCount: z.number().int(),
});
export type PortfolioTotals = z.infer<typeof PortfolioTotalsSchema>;

/** How trustworthy the headline total is right now. `syncing` = no on-chain snapshot yet, or a
 *  multi-slot read on a large wallet (bounded skew); `fresh` = a clean single-slot snapshot. */
export const FreshnessSchema = z.enum(['fresh', 'syncing', 'stale']);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const WalletStateSchema = z.object({
  /** wallet address, or "all" for the aggregated view. */
  scope: z.string(),
  totals: PortfolioTotalsSchema,
  openPositions: z.array(OpenPositionSchema),
  /** Solana slot the on-chain total is anchored to (null before the first snapshot). */
  asOfSlot: z.number().int().nullable().default(null),
  freshness: FreshnessSchema.default('syncing'),
  updatedAt: z.number().int(),
});
export type WalletState = z.infer<typeof WalletStateSchema>;
