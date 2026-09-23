import type { PositionBins, PositionHistory, StrategyFamily } from '@binsight/shared';
import type { LoadedPoolMeta, OnchainWalletSnapshot, SnapshotPlan } from '@/domain/dlmm';

/** Chain-facing ports: prices, token metadata, the WS backbone and the DLMM on-chain reads. */

/** Token spot prices in SOL via an aggregator (Jupiter). */
export interface PriceGateway {
  /** mint → price in SOL. Mints with no available price are absent from the map. */
  getPricesSol(mints: string[]): Promise<Map<string, number>>;
  /** SOL's own spot price in USD — for the few USD figures we surface (e.g. share cards). Null if unavailable. */
  getSolUsd(): Promise<number | null>;
}

/** Display metadata for a token mint (symbol + optional icon URL). */
export interface TokenMeta {
  symbol: string;
  icon?: string;
}

/** Resolves token display metadata by mint (DAS/Jupiter), mint-keyed so it dedups across users. */
export interface TokenMetadataGateway {
  /** mint → metadata. Every requested mint is present (unknown mints get a short-address fallback symbol). */
  resolve(mints: string[]): Promise<Map<string, TokenMeta>>;
}

export interface OnchainDlmmGateway {
  /** Per-bin liquidity distribution of one open position (Price-Bin histogram). */
  positionBins(positionAddress: string): Promise<PositionBins | null>;
  /** On-chain event timeline of a position (History drawer). */
  positionHistory(positionAddress: string): Promise<PositionHistory | null>;
  /** Token decimals for a mint (cached) — needed to scale residual amounts for valuation. */
  decimalsOf(mint: string): Promise<number>;
  /** Pinned-slot snapshot of a wallet's positions + idle balances; returns the reusable discovery plan. */
  snapshotWallet(
    ownerStr: string,
    cachedPlan?: SnapshotPlan,
  ): Promise<OnchainWalletSnapshot & { plan: SnapshotPlan }>;
  /** Drop a wallet's cached idle-token read so the next snapshot re-reads its balances. Called on any
   *  activity for that wallet: token balances only move when it transacts. */
  invalidateIdle(ownerStr: string): void;
}

/** Reads (decodes) a DLMM pool's immutable metadata from chain — the injectable side of pool-meta. */
export interface PoolMetaReader {
  /** Decode the LbPair account for `pool`; null if missing/undecodable or no SOL side resolved. */
  loadPoolMeta(pool: string): Promise<LoadedPoolMeta | null>;
}

/** Resolves a position's strategy family (Spot/Curve/BidAsk) once from its on-chain open transaction. */
export interface StrategyResolver {
  resolve(positionAddress: string): Promise<StrategyFamily | null>;
}

/** Sinks per-source success/failure so the engine can report a real, per-service health status. */
export interface HealthReporter {
  record(source: string, ok: boolean, detail?: string): void;
}
