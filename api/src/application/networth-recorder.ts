import type { WalletState } from '@binsight/shared';
import type { Logger } from 'pino';

/** One point of the persisted Net Worth curve (the TRUE on-chain wallet total + its split). The
 *  application owns this contract; the persistence adapter implements it (no application→infra import). */
export interface NetworthCurveRow {
  ts: number;
  walletTotalSol: number;
  tvlSol: number;
  idleSol: number;
}

/** The slice of NetworthSnapshotRepository this recorder needs (kept narrow so it's trivially stubbable). */
export interface NetworthSnapshotStore {
  record(wallet: string, p: NetworthCurveRow): Promise<void>;
}

// 15-min UTC bucket = floor(unix_seconds / 900). One snapshot is persisted per wallet per bucket.
const BUCKET_SECONDS = 900;

/**
 * Persists the TRUE wallet Net Worth (tvl + idle) over time, forward-only, from the live `state`
 * stream. There is no reliable historical mark-to-market, so we sample going forward — at most once
 * per wallet per 15-min bucket.
 *
 * This deliberately does NOT reconcile against the legacy `wallet_flows` ledger. That ledger is
 * SOL-only, while the valuation covers every SPL and Token-2022 asset the wallet holds; comparing the
 * two was never dimensionally valid and produced both false alarms and false confidence.
 */
export class NetworthRecorder {
  // wallet → last 15-min bucket recorded this process (in-memory throttle; the DB upsert is the floor).
  private readonly lastBucket = new Map<string, number>();

  constructor(
    private readonly bus: { on(type: 'state', handler: (s: WalletState) => void): () => void },
    private readonly snapRepo: NetworthSnapshotStore,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.bus.on('state', (s) => void this.onState(s));
  }

  private async onState(state: WalletState): Promise<void> {
    // `state` is emitted per-wallet (scope === the wallet address); the aggregated 'all' scope is only
    // served on demand and never reaches the bus. Skip it defensively so a future change can't make us
    // persist a double-counted total under a non-address key.
    const wallet = state.scope;
    if (wallet === 'all') return;
    // Only persist an exact, slot-consistent chain read. An incomplete one (unfetched bin-array,
    // undecodable mint — surfaced as freshness!=='fresh') would deflate/inflate the total; skip it
    // WITHOUT consuming the bucket so a later fresh sample records the real number.
    //
    // A merely PARTIAL valuation is still recorded. Now that the inventory covers every token held, an
    // asset with no Jupiter quote and no pool fallback is one with no liquid market value; excluding it
    // makes the point a slight lower bound, whereas refusing such points would stop the curve entirely.
    if (state.freshness !== 'fresh') return;

    const ts = Date.now();
    const bucket = Math.floor(ts / 1000 / BUCKET_SECONDS);
    if (this.lastBucket.get(wallet) === bucket) return; // already recorded this wallet's current bucket
    this.lastBucket.set(wallet, bucket);

    const { walletTotalSol, tvlSol, idleSol } = state.totals;
    try {
      await this.snapRepo.record(wallet, { ts, walletTotalSol, tvlSol, idleSol });
    } catch (err) {
      // A failed write must not poison the throttle: drop the marker so the next state for this wallet
      // retries instead of silently skipping the whole 15-min bucket.
      this.lastBucket.delete(wallet);
      this.logger.error({ err, wallet }, 'networth snapshot record failed');
    }
  }
}
