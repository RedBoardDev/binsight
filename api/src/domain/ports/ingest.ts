import type { DlmmLeg, SwapFlowRow, WalletFlowRow } from '@binsight/solana-core';
import type { DailyFlow, IngestCursor, LoadedPoolMeta, StoredLeg } from '@/domain/dlmm';

/** Ports of the wallet transaction ingest and the history it persists. */

/** Persists decoded DLMM legs + pool metadata (the on-chain history store). */
export interface LegRepository {
  /** Idempotently replace the legs of a set of signatures (delete-then-insert) — safe to re-run. */
  replaceForSignatures(wallet: string, signatures: string[], legs: DlmmLeg[]): Promise<void>;
  legsByPosition(position: string): Promise<StoredLeg[]>;
  legsByWallet(wallet: string): Promise<StoredLeg[]>;
  /** Legs for a SUBSET of positions (the open set) — the cheap cadence-refresh path. */
  legsByPositions(positions: string[]): Promise<StoredLeg[]>;
  /** Cached metadata for a set of pools (immutable on-chain; populated lazily). */
  getPoolMetas(pools: string[]): Promise<Map<string, LoadedPoolMeta>>;
  /** Persist a pool's decoded metadata (idempotent; immutable so a re-write is a no-op). */
  putPoolMeta(pool: string, meta: LoadedPoolMeta): Promise<void>;
}

/** Persists the wallet cash-flow that backs the wallet PnL curve (raw flows + daily rollup). */
export interface WalletFlowRepository {
  /** Idempotently store paged flows (PK wallet,signature) and maintain the daily rollup atomically. */
  upsertFlows(wallet: string, flows: WalletFlowRow[]): Promise<void>;
  /** The daily flow series for one or more wallets since `sinceSec`, summed in SQL by UTC day. */
  dailyFlows(wallets: string[], sinceSec: number): Promise<DailyFlow[]>;
  /** Authoritatively rebuild the daily rollup from the raw flows (idempotent boot repair). */
  rebuildDaily(): Promise<void>;
}

/** Persists the decoded swap legs that feed the realized-PnL FIFO walk. */
export interface SwapFlowRepository {
  /** Idempotently store decoded swap legs (PK wallet,signature,mint) — re-ingesting a tx is a no-op. */
  upsertMany(rows: SwapFlowRow[]): Promise<void>;
  /** All persisted swap legs for a wallet, oldest→newest — the order the FIFO walk consumes them. */
  byWallet(wallet: string): Promise<SwapFlowRow[]>;
}

/** The wallet's single ingest cursor (legs, cash-flows and swap legs share one pagination). */
export interface IngestCursorStore {
  get(wallet: string): Promise<IngestCursor | null>;
  set(wallet: string, cursor: IngestCursor): Promise<void>;
  /** True iff every wallet's history has been read to genesis. */
  allComplete(wallets: string[]): Promise<boolean>;
}

export interface IngestResult {
  txs: number;
  legs: number;
  flows: number;
  swaps: number;
  /** The wallet's history is read to genesis. */
  complete: boolean;
  /** It already was before this run (a known wallet, not a first-ever backfill). */
  wasComplete: boolean;
}

/** The wallet's single transaction ingest: pages signatures once, fetches each new transaction once, and
 *  decodes it into DLMM legs, cash-flows and swap legs together. */
export interface WalletTxIngestPort {
  ingest(wallet: string, opts?: { onProgress?: (txs: number) => void }): Promise<IngestResult>;
}
