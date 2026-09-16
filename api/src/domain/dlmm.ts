import type { PublicKey } from '@solana/web3.js';

/**
 * Pure DLMM data-shape types shared across the application + infrastructure layers. These are the
 * domain contracts for decoded legs, on-chain snapshots and per-position valuations — no I/O, no
 * adapters; the decoder/gateway classes live in infrastructure and import these DOWNWARD.
 */

/** One normalized liquidity movement: tokens going INTO (deposit) or OUT OF (withdraw) the position. */
export interface DlmmLeg {
  signature: string;
  blockTime: number | null;
  position: string;
  lbPair: string;
  /** deposit = capital in (cost); withdraw = capital out; claim = fees out (income). */
  kind: 'deposit' | 'withdraw' | 'claim';
  /** Historical price anchor: the pool's active bin at this tx. null is valid for a legacy ClaimFee
   * event with no sibling carrying a bin — the exact X/Y quantities are retained even though Meteora
   * emitted no price anchor, so the quote-side amount survives and the rest is marked partial. */
  activeBinId: number | null;
  /** raw token-X lamports moved in this leg. */
  amountX: bigint;
  /** raw token-Y lamports moved in this leg. */
  amountY: bigint;
}

/** A single position's on-chain holdings (raw base units; SOL valuation is layered on top). */
export interface OnchainPositionValue {
  positionAddress: string;
  lbPair: string;
  tokenXMint: string;
  tokenYMint: string;
  amountX: bigint;
  amountY: bigint;
  feeX: bigint;
  feeY: bigint;
  decimalsX: number;
  decimalsY: number;
  activeId: number;
  binStep: number;
  lowerBinId: number;
  upperBinId: number;
  /** lamports locked as rent in the PositionV2 account (redeemed on close). */
  lamports: bigint;
}

/** A wallet's full state at one slot: idle balances + all DLMM positions, raw. */
export interface OnchainWalletSnapshot {
  owner: string;
  slot: number;
  /** max−min context.slot across getMultipleAccounts chunks (0 = a true single slot). */
  slotSkew: number;
  nativeLamports: bigint;
  /** Every classic SPL and Token-2022 account the wallet controls, associated or not — not a fixed
   * shortlist of stablecoins. Quantities stay raw/exact; `decimals` is 0 only when the mint could not
   * be decoded, which also flags the snapshot incomplete. */
  idleTokens: {
    accountAddress?: string;
    tokenProgram?: 'spl' | 'token2022';
    mint: string;
    amount: bigint;
    decimals: number;
  }[];
  positions: OnchainPositionValue[];
  /** false when the chain read was under/over-stated: a token's decimals was unknown (RPC miss → would
   *  mis-scale the amount) or a share>0 bin's bin-array was absent (amounts under-counted). Bubbles up
   *  to `OnchainValued.complete` → freshness → and gates Net Worth persistence. */
  complete: boolean;
}

/**
 * Cacheable discovery plan for a wallet snapshot: the position SET + ranges + derived account keys.
 * Stays valid until a WS open/close/add/remove changes the set or a position's range (the engine
 * invalidates it on those events). Lets a quiet snapshot skip the 10-credit getProgramAccounts and
 * the round-1 header read, going straight to the byte-identical round-2 valuation.
 */
export interface SnapshotPlan {
  positionKeys: PublicKey[];
  lbPairByPos: Map<string, PublicKey>;
  coverageByPos: Map<string, number[]>;
  lbPairKeys: PublicKey[];
  binArrayKeys: PublicKey[];
  binArrayMeta: { lbPair: string; index: number }[];
  /** All owner-controlled classic SPL + Token-2022 accounts, discovered by owner-indexed RPC. */
  tokenAccountKeys: PublicKey[];
}

/** SOL valuation of a whole on-chain wallet snapshot. Token side priced via Jupiter (`priceSol`),
 *  falling back to the on-chain pool price when a Jupiter quote is missing. */
export interface OnchainValued {
  slot: number;
  slotSkew: number;
  tvlSol: number;
  idleSol: number;
  unclaimedFeesSol: number;
  lockedRentSol: number;
  /** tvl + idle + unclaimed fees + locked rent ("tout inclus"). */
  walletTotalSol: number;
  positionCount: number;
  /** Chain/account decoding completeness (unfetched bin-array, undecodable mint). DISTINCT from price
   * coverage: an exact, current inventory can still be only partially priced, and that must be
   * displayed rather than disguised as "syncing" — see valuationStatus. */
  chainComplete: boolean;
  /** Price coverage. 'partial' means a held asset had no Jupiter quote and no pool fallback, so
   * walletTotalSol is an explicit LOWER BOUND rather than a wrong number presented as exact. */
  valuationStatus: 'complete' | 'partial';
  /** false for a cached price-only re-mark. An exact RPC snapshot stays authoritative even when its
   * total is a labelled lower bound; only a non-authoritative mark is barred from the Net Worth curve. */
  authoritative: boolean;
  /** Legacy aggregate: chainComplete AND a complete valuation. Kept for existing consumers. */
  complete: boolean;
  /** per-position liquidity value in SOL (excludes unclaimed fees), keyed by positionAddress. */
  sizeSolByPosition: Map<string, number>;
  feeSolByPosition: Map<string, number>;
}

export interface PoolMeta {
  binStep: number;
  /** which side of the pool is SOL — sets the valuation direction. */
  solSide: 'X' | 'Y';
}

/** Native quote convention for a supported DLMM pool. Raw DLMM prices are always Y-base-units per
 * X-base-unit; quoteSide selects the orientation and quoteDecimals converts raw quote units to UI. */
export interface QuoteMeta {
  binStep: number;
  quoteSide: 'X' | 'Y';
  quoteDecimals: number;
}

/** Per-position economics in the pool's native quote. Unlike PositionEconomics this is not assumed
 * to be SOL: a USDC pool produces USDC values and a USDT pool produces USDT values. */
export interface PositionEconomicsQuote {
  depositQuote: number;
  withdrawQuote: number;
  claimedFeesQuote: number;
  pnlQuote: number;
  valuationStatus: 'complete' | 'partial';
  /** Legs whose amounts are exact but carry no price anchor, so only the quote side could be counted. */
  unpricedLegs: number;
}

/** Per-position SOL economics from decoded legs, mark-to-pool (single source for the PnL split). */
export interface PositionEconomics {
  /** Σ deposit legs valued in SOL — the cost basis. */
  depositSol: number;
  /** Σ withdraw legs valued in SOL. */
  withdrawSol: number;
  /** Σ claim legs valued in SOL — realized fees. */
  claimedFeesSol: number;
  /** withdrawSol + claimedFeesSol − depositSol — the realized mark-to-pool PnL. */
  pnlSol: number;
}

/** A persisted DLMM leg as read back from storage — the projection input (no wallet/owner column). */
export interface StoredLeg {
  signature: string;
  position: string;
  lbPair: string;
  kind: 'deposit' | 'withdraw' | 'claim';
  activeBinId: number | null;
  amountX: bigint;
  amountY: bigint;
  blockTime: number | null;
}

/** Per-wallet DLMM leg-ingest progress (newest/oldest signature reached + whether genesis was hit). */
export interface IngestCursor {
  oldestSig: string | null;
  newestSig: string | null;
  complete: boolean;
}

/** Decoded, cacheable metadata for a DLMM pool (immutable on-chain). `solSide` null = non-SOL-quote. */
export interface LoadedPoolMeta {
  binStep: number;
  /** which side of the pool is SOL, or null for a non-SOL-quote pool (valued elsewhere). */
  solSide: 'X' | 'Y' | null;
  mintX: string;
  mintY: string;
}

/** Per-wallet flow-ingest progress (same semantics as the DLMM ingest cursor). */
export interface FlowCursor {
  oldestSig: string | null;
  newestSig: string | null;
  complete: boolean;
}

/** One UTC day of aggregated wallet flow, summed in SQL (never transfers per-tx rows to the app). */
export interface DailyFlow {
  date: string; // YYYY-MM-DD (UTC)
  trading: number; // net trading SOL that day
  external: number; // net external (CEX / non-trading) SOL that day
}

/** A wallet tx reduced for PERSISTENCE: net SOL+WSOL flow + trading flag, keyed by signature. */
export interface WalletFlowRow {
  signature: string;
  timestamp: number; // unix seconds
  type: string;
  solFlow: number; // signed net SOL+WSOL change, in SOL
  isTrading: boolean;
}

/** Which way a persisted swap leg went: SOL→token ('buy') or token→SOL ('sell'). */
export type SwapSide = 'buy' | 'sell';

/** A persisted FIFO input for realized-PnL: one clean token↔SOL leg of a tx, keyed by (wallet, signature,
 *  mint). Immutable; the FIFO walk reads these from the DB + deltas instead of re-paging the Enhanced API. */
export interface SwapFlowRow {
  wallet: string;
  signature: string;
  ts: number; // unix seconds
  mint: string;
  tokenAmount: number; // human token units (decimal-adjusted)
  solAmount: number; // SOL paid (buy) / received (sell)
  side: SwapSide;
}

/** A wallet's realized token→SOL sell (clean single-token swap), decimal-adjusted amount + SOL out. */
export interface ResidualSell {
  /** unix seconds */
  ts: number;
  mint: string;
  /** residual token units sold (human, decimal-adjusted) */
  tokenAmount: number;
  /** SOL actually received for this sell */
  solReceived: number;
}

export function classifyInstruction(
  instr: string,
): 'open' | 'close' | 'add' | 'remove' | 'claim' | null {
  const i = instr.toLowerCase();
  if (i.startsWith('initializeposition') || i.startsWith('openposition')) return 'open';
  if (i.startsWith('closeposition')) return 'close';
  if (i.startsWith('addliquidity')) return 'add';
  if (i.startsWith('removeliquidity')) return 'remove';
  if (i.startsWith('claimfee') || i.startsWith('claimreward')) return 'claim';
  return null;
}
