import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────
 * Positions
 * ──────────────────────────────────────────────────────────────────────── */

export const RangeStatusSchema = z.enum(['in', 'out_up', 'out_down', 'unknown']);
export type RangeStatus = z.infer<typeof RangeStatusSchema>;

/** Liquidity-shape family chosen at open (decoded once from the on-chain add-liquidity instruction). */
export const StrategyFamilySchema = z.enum(['Spot', 'Curve', 'BidAsk']);
export type StrategyFamily = z.infer<typeof StrategyFamilySchema>;

/** Which side of the pool is the QUOTE unit — the one a position's economics are denominated in. */
export const QuoteSideSchema = z.enum(['X', 'Y']);
export type QuoteSide = z.infer<typeof QuoteSideSchema>;

/** How much of a position's economics could actually be valued: every leg, some, or none. */
export const PositionValuationStatusSchema = z.enum(['complete', 'partial', 'unpriced']);
export type PositionValuationStatus = z.infer<typeof PositionValuationStatusSchema>;

/** An open position (live, mark-to-market in SOL). */
export const OpenPositionSchema = z.object({
  positionAddress: z.string(),
  wallet: z.string(),
  poolAddress: z.string(),
  tokenX: z.string(),
  tokenY: z.string(),
  tokenXMint: z.string(),
  /** Display quote mint. Optional on the wire while older clients/rows migrate. */
  tokenYMint: z.string().optional(),
  quoteMint: z.string().optional(),
  quoteSymbol: z.string().optional(),
  quoteDecimals: z.number().int().nonnegative().optional(),
  quoteSide: QuoteSideSchema.optional(),
  valuationStatus: PositionValuationStatusSchema.optional(),
  economicStatus: z.enum(['funded', 'empty_shell']).optional(),
  tokenXIcon: z.string().optional(),
  tokenYIcon: z.string().optional(),
  strategy: StrategyFamilySchema.nullable().default(null),
  sizeSol: z.number(), // current value (unrealizedPnl.balancesSol)
  pnlSol: z.number(),
  pnlPctSol: z.number(),
  claimedFeesSol: z.number(),
  unclaimedFeesSol: z.number(),
  /** Native pool-quote values. They equal the SOL fields for SOL pools and are USDC for USDC pools. */
  sizeQuote: z.number().optional(),
  pnlQuote: z.number().optional(),
  pnlPctQuote: z.number().optional(),
  claimedFeesQuote: z.number().optional(),
  unclaimedFeesQuote: z.number().optional(),
  rangeStatus: RangeStatusSchema,
  minPrice: z.number(),
  maxPrice: z.number(),
  poolPrice: z.number().nullable(),
  /** epoch ms when the position first went out-of-range (for duration alerts). */
  outOfRangeSince: z.number().int().nullable(),
  openedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
export type OpenPosition = z.infer<typeof OpenPositionSchema>;

/** A closed position (realized PnL in SOL, validated == on-chain). */
export const ClosedPositionSchema = z.object({
  positionAddress: z.string(),
  wallet: z.string(),
  poolAddress: z.string(),
  tokenX: z.string(),
  tokenY: z.string(),
  tokenXMint: z.string(),
  /** Display quote mint. Optional on the wire while older clients/rows migrate. */
  tokenYMint: z.string().optional(),
  quoteMint: z.string().optional(),
  quoteSymbol: z.string().optional(),
  quoteDecimals: z.number().int().nonnegative().optional(),
  quoteSide: QuoteSideSchema.optional(),
  valuationStatus: PositionValuationStatusSchema.optional(),
  economicStatus: z.enum(['funded', 'empty_shell']).optional(),
  tokenXIcon: z.string().optional(),
  tokenYIcon: z.string().optional(),
  strategy: StrategyFamilySchema.nullable().default(null),
  pnlSol: z.number(),
  pnlPctSol: z.number(),
  feesSol: z.number(),
  depositSol: z.number(),
  withdrawSol: z.number(),
  /** Native pool-quote values; win/loss and ROI must use these when present. */
  pnlQuote: z.number().optional(),
  pnlPctQuote: z.number().optional(),
  feesQuote: z.number().optional(),
  depositQuote: z.number().optional(),
  withdrawQuote: z.number().optional(),
  openedAt: z.number().int().nullable(),
  closedAt: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  // DLMM bin range (base price in SOL) — drives the position chart's range band. Optional: absent on
  // very old rows predating range capture.
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
});
export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Position detail — per-bin liquidity (Price-Bin histogram)
 * ──────────────────────────────────────────────────────────────────────── */

/** One price bin of a position: its price and the (UI) token amounts held there. */
export const PositionBinSchema = z.object({
  binId: z.number().int(),
  /** price of token X in token Y (UI units). */
  price: z.number(),
  amountX: z.number(),
  amountY: z.number(),
});
export type PositionBin = z.infer<typeof PositionBinSchema>;

/** Per-bin liquidity distribution of one OPEN position at a single slot. */
export const PositionBinsSchema = z.object({
  slot: z.number().int(),
  activeBinId: z.number().int(),
  binStep: z.number().int(),
  tokenXMint: z.string(),
  tokenYMint: z.string(),
  bins: z.array(PositionBinSchema),
});
export type PositionBins = z.infer<typeof PositionBinsSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Position history — on-chain event timeline (reconstructed via Helius)
 * ──────────────────────────────────────────────────────────────────────── */

export const PositionEventKindSchema = z.enum(['open', 'deposit', 'withdraw', 'claim', 'close']);
export type PositionEventKind = z.infer<typeof PositionEventKindSchema>;

/** One lifecycle event of a position, decoded from its on-chain transaction history. */
export const PositionEventSchema = z.object({
  kind: PositionEventKindSchema,
  /** epoch ms (block time of the transaction). */
  at: z.number().int(),
  signature: z.string(),
  /** UI amount of token X moved by this event (0 when none). */
  amountX: z.number(),
  /** UI amount of token Y moved by this event (0 when none). */
  amountY: z.number(),
});
export type PositionEvent = z.infer<typeof PositionEventSchema>;

/** Full event timeline of a position (oldest → newest), reconstructed from chain. */
export const PositionHistorySchema = z.object({
  positionAddress: z.string(),
  tokenXMint: z.string(),
  tokenYMint: z.string(),
  events: z.array(PositionEventSchema),
});
export type PositionHistory = z.infer<typeof PositionHistorySchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Position price chart — OHLCV candles (GeckoTerminal) — server DTO
 * ──────────────────────────────────────────────────────────────────────── */

/** One OHLC candle for the position price chart — bar-open time (unix seconds), price in SOL (the
 *  same unit as a position's range), volume in the base token. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
