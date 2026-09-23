/** What the decoders produce from a transaction, and the stream contract. No I/O. */

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

/** A position lifecycle step, as decoded from a DLMM instruction. */
export type PositionEventKind = 'open' | 'deposit' | 'withdraw' | 'claim' | 'close';

/** Anything that reports live WS connectivity. */
export interface ConnectionStatus {
  isConnected(): boolean;
}

/** What a stream notification says about a watched wallet's transaction. */
export interface StreamActivity {
  /** The transaction's logs mention the DLMM program (it may have moved a position). */
  touchesDlmm: boolean;
}

/** A per-wallet transaction stream (Solana `logsSubscribe`). A notification only TRIGGERS a
 *  cursor-based ingest; it offers no replay, so correctness must rest on a periodic poll. */
export interface TransactionStreamPort extends ConnectionStatus {
  /** (Re)subscribe a wallet; `onActivity` fires for each successful transaction that mentions it. */
  watch(wallet: string, onActivity: (wallet: string, activity: StreamActivity) => void): void;
  unwatch(wallet: string): void;
  /** Fires on every (re)connect: nothing that happened while the socket was down was delivered. */
  onReconnect(cb: () => void): void;
  onConnectionChange(cb: (connected: boolean) => void): void;
  start(): void;
  stop(): void;
}
