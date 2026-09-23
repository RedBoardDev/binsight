import type { Logger } from 'pino';
import type { LoadedPoolMeta, StoredLeg } from '@/domain/dlmm';
import { positionEconomicsQuote, quoteConventionOf } from '@/domain/dlmm-pnl';
import type { LegRepository, PoolMetaReader } from '@/domain/ports';

export interface PositionPnl {
  position: string;
  pool: string;
  /** mark-to-pool realized PnL in SOL (LPAgent-style), reconstructed fully on-chain. 0 if !solDenominated. */
  pnlSol: number;
  /** Σ deposit legs in SOL — the cost basis (0 if !solDenominated). */
  depositSol: number;
  /** Σ withdraw legs in SOL (0 if !solDenominated). */
  withdrawSol: number;
  /** Σ claim legs in SOL — realized fees (0 if !solDenominated). */
  claimedFeesSol: number;
  /** Native pool-quote economics. For SOL pools these equal the legacy SOL fields; for USDC pools
   * these are USDC and the legacy SOL fields remain zero until a historical normalization exists. */
  pnlQuote: number;
  depositQuote: number;
  withdrawQuote: number;
  claimedFeesQuote: number;
  quoteMint: string;
  quoteSymbol: string | null;
  quoteDecimals: number | null;
  quoteSide: 'X' | 'Y';
  valuationStatus: 'complete' | 'partial' | 'unpriced';
  economicStatus: 'funded' | 'empty_shell';
  legs: number;
  /** Display base mint (the side opposite the selected native quote). */
  tokenMint: string;
  /** Canonical on-chain pool mint order, retained independently from display base/quote order. */
  mintX: string;
  mintY: string;
  /** false for a non-SOL-quote pool: SOL economics are 0 and the position is surfaced flagged, never dropped. */
  solDenominated: boolean;
  /** epoch ms of the first on-chain event (open). */
  openedAt: number;
  /** epoch ms of the last on-chain leg. The real close iff the live snapshot no longer holds this position. */
  closedAt: number;
  /** closedAt − openedAt, in seconds. */
  durationSeconds: number;
}

/**
 * Computes per-position mark-to-pool PnL from the ingested on-chain legs — the "Positions" view,
 * fully decoupled from Meteora and covering all history (incl. the positions Meteora purges).
 * Pool metadata (binStep/SOL side) is loaded once per pool and cached.
 */
export class DlmmPositionPnl {
  private readonly poolCache = new Map<string, LoadedPoolMeta>();

  constructor(
    private readonly repo: LegRepository,
    private readonly poolReader: PoolMetaReader,
    private readonly logger: Logger,
  ) {}

  /** Pool metadata is immutable, so a loaded one is cached for good — but a miss never is: a single
   *  RPC blip used to hide every position of the pool from every projection until the next restart. */
  private async poolMeta(pool: string): Promise<LoadedPoolMeta | null> {
    const hit = this.poolCache.get(pool);
    if (hit) return hit;
    let meta: LoadedPoolMeta | null = null;
    try {
      meta = await this.poolReader.loadPoolMeta(pool);
    } catch (err) {
      this.logger.warn({ err, pool }, 'loadPoolMeta failed — retried on the next projection');
    }
    if (!meta) return null;
    this.poolCache.set(pool, meta);
    // Persist it so the next boot batch-reads it instead of re-fetching from chain.
    await this.repo.putPoolMeta(pool, meta).catch(() => undefined);
    return meta;
  }

  async pnlByPosition(wallet: string): Promise<PositionPnl[]> {
    return this.project(await this.repo.legsByWallet(wallet), wallet);
  }

  /** Project a SUBSET of positions (the live open set) — the cheap cadence-refresh path that loads only
   *  those positions' legs, never the wallet's whole history. */
  async pnlForPositions(positions: string[]): Promise<PositionPnl[]> {
    return this.project(await this.repo.legsByPositions(positions));
  }

  /** Group legs by position and value each (mark-to-pool economics + non-SOL flag). Pool metadata is
   *  warmed from the persistent cache in one query so a reboot doesn't re-read every LbPair from chain. */
  private async project(legs: StoredLeg[], wallet = ''): Promise<PositionPnl[]> {
    const byPos = new Map<string, StoredLeg[]>();
    for (const l of legs) {
      const arr = byPos.get(l.position);
      if (arr) arr.push(l);
      else byPos.set(l.position, [l]);
    }
    const pools = [...new Set([...byPos.values()].map((plegs) => plegs[0]!.lbPair))];
    for (const [pool, meta] of await this.repo.getPoolMetas(pools)) this.poolCache.set(pool, meta);

    const out: PositionPnl[] = [];
    let failed = 0;
    for (const [position, plegs] of byPos) {
      const pool = plegs[0]!.lbPair;
      const meta = await this.poolMeta(pool);
      if (!meta) {
        // Genuine load failure (missing/undecodable LbPair account) — surfaced loudly below, never silent.
        failed++;
        continue;
      }
      const times = plegs.map((l) => l.blockTime ?? 0).filter((t) => t > 0);
      const openedAt = times.length ? Math.min(...times) * 1000 : 0;
      const closedAt = times.length ? Math.max(...times) * 1000 : 0;
      const durationSeconds = openedAt && closedAt ? Math.round((closedAt - openedAt) / 1000) : 0;
      const convention = quoteConventionOf(meta.mintX, meta.mintY);
      const quoteSide = convention?.quoteSide ?? 'Y';
      const quoteMint = convention?.quoteMint ?? meta.mintY;
      const tokenMint = convention?.baseMint ?? meta.mintX;
      const quote = convention
        ? positionEconomicsQuote(plegs, {
            binStep: meta.binStep,
            quoteSide,
            quoteDecimals: convention.quoteDecimals,
          })
        : {
            pnlQuote: 0,
            depositQuote: 0,
            withdrawQuote: 0,
            claimedFeesQuote: 0,
            valuationStatus: 'partial' as const,
            unpricedLegs: plegs.length,
          };
      const solDenominated = convention?.quoteSymbol === 'SOL';
      const economicStatus = plegs.some((leg) => leg.amountX !== 0n || leg.amountY !== 0n)
        ? 'funded'
        : 'empty_shell';
      out.push({
        position,
        pool,
        pnlSol: solDenominated ? quote.pnlQuote : 0,
        depositSol: solDenominated ? quote.depositQuote : 0,
        withdrawSol: solDenominated ? quote.withdrawQuote : 0,
        claimedFeesSol: solDenominated ? quote.claimedFeesQuote : 0,
        ...quote,
        quoteMint,
        quoteSymbol: convention?.quoteSymbol ?? null,
        quoteDecimals: convention?.quoteDecimals ?? null,
        quoteSide,
        valuationStatus: convention ? quote.valuationStatus : 'unpriced',
        economicStatus,
        legs: plegs.length,
        tokenMint,
        mintX: meta.mintX,
        mintY: meta.mintY,
        solDenominated,
        openedAt,
        closedAt,
        durationSeconds,
      });
    }
    if (failed)
      this.logger.warn({ wallet, failed }, 'projection: pools failed to load — positions skipped');
    return out;
  }
}
