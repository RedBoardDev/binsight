import type { ClosedPosition, OpenPosition, Stats, StrategyFamily } from '@binsight/shared';

/** Ports of the positions table and the realized PnL persisted beside it. */

/** The write side of the positions table: the projection and the realized-PnL pass. */
export interface PositionStore {
  /** Upsert closed rows; a row is rewritten only when one of its figures changed. */
  upsertClosed(positions: ClosedPosition[]): Promise<void>;
  /** Replace a wallet's open set: listed positions are upserted, the others go to 'pending_close' —
   *  except `stillOpen`, positions known to be open whose row is left untouched. */
  replaceOpenForWallet(
    wallet: string,
    positions: OpenPosition[],
    stillOpen?: string[],
  ): Promise<void>;
  getOpen(wallet: string): Promise<OpenPosition[]>;
  /** Open positions plus those in 'pending_close' (gone on-chain, close not projected yet) — the prior
   *  open set a sync diffs against, so a settling position still counts as an open → closed transition. */
  getOpenOrPendingClose(wallet: string): Promise<OpenPosition[]>;
  /** status + closedAt of every position of a wallet. The FIFO needs open positions too (their deposits
   *  consume token inventory) but reports only closed ones. */
  positionStatusForWallet(
    wallet: string,
  ): Promise<Map<string, { status: string; closedAt: number | null }>>;
  /** Write the authoritative realized PnL of many closed positions; returns how many changed. */
  setAuthoritativePnlMany(byPosition: Map<string, number>): Promise<number>;
  /** Persist a position's strategy family (decoded once from its open tx; immutable). */
  setStrategy(positionAddress: string, family: StrategyFamily): Promise<void>;
  /** Strategy family of each given position that has one. */
  strategiesOf(positions: string[]): Promise<Map<string, StrategyFamily>>;
  /** Open positions whose strategy hasn't been resolved yet. */
  addressesMissingStrategy(limit: number): Promise<string[]>;
}

/** One page request of the closed history. */
export interface ClosedQuery {
  page: number;
  pageSize: number;
  q?: string;
  sort?: 'recent' | 'pnl' | 'fees' | 'duration';
  dir?: 'asc' | 'desc';
  result?: 'all' | 'win' | 'loss';
}

export interface ClosedPage {
  rows: ClosedPosition[];
  total: number;
}

/** Read models over the positions table (HTTP). */
export interface PositionQueries {
  getClosed(wallets: string[], opts: ClosedQuery): Promise<ClosedPage>;
  getClosedByAddress(positionAddress: string): Promise<ClosedPosition | null>;
  /** The wallet that owns a position (open or closed) — scopes per-position routes to a watchlist. */
  walletOfPosition(positionAddress: string): Promise<string | null>;
  /** Closed-position analytics computed in SQL. Omits what this store can't know: `scope` and the
   *  realized PnL that belongs to no position. */
  statsAggregate(
    wallets: string[],
    sinceMs: number,
  ): Promise<Omit<Stats, 'scope' | 'outsidePositionsPnlSol'>>;
  /** Realized PnL per time bucket (all-time, ascending); the caller fills gaps and the running total. */
  profitBuckets(wallets: string[], bucketMs: number): Promise<{ t: number; realized: number }[]>;
}

/** Persists the half of a wallet's realized PnL that belongs to no position (see RealizedPnlResult). */
export interface WalletRealizedStore {
  set(wallet: string, tradingPnlSol: number): Promise<void>;
  sumFor(wallets: string[]): Promise<number>;
}
