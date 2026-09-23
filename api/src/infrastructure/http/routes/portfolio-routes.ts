import type { Candle, WalletState } from '@binsight/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '@/application/event-bus';
import { BUCKET_MS, type Bucket, isBucket, profitHistory } from '@/application/profit-history';
import type { WalletPnlService } from '@/application/wallet-pnl-service';
import type { PositionQueries, WalletRealizedStore } from '@/domain/ports';
import type { NetworthSnapshotRepository } from '@/infrastructure/persistence/networth-snapshot-repository';
import { VersionedCache } from '@/util/cache';
import { intParam, MAX_HISTORY_DAYS, type WatchScope } from './context';

export interface PortfolioRouteDeps {
  bus: EventBus;
  scope: WatchScope;
  getState(wallets: string[], scope: string): WalletState;
  repo: Pick<PositionQueries, 'statsAggregate' | 'profitBuckets'>;
  walletPnl: WalletPnlService;
  networthSnapshots: NetworthSnapshotRepository;
  walletRealized: WalletRealizedStore;
  ohlcv(pool: string, timeframe: string): Promise<Candle[]>;
  solUsd(): Promise<number | null>;
}

const DAY_MS = 86_400_000;

/** Live state, stats and curves — everything scoped to the caller's watchlist. */
export function registerPortfolioRoutes(app: FastifyInstance, deps: PortfolioRouteDeps): void {
  const { scope } = deps;

  // Aggregation-heavy reads are cached briefly and invalidated per wallet when its closed set changes,
  // so repeated reads between writes come from memory and a viewer herd collapses to one computation.
  const statsCache = new VersionedCache(15_000);
  const curveCache = new VersionedCache(30_000);
  deps.bus.on('closedChanged', (e) => {
    statsCache.bump(e.wallet);
    curveCache.bump(e.wallet);
  });
  // Market data: pure TTL, so viewers of the same pool/timeframe share one GeckoTerminal call a minute.
  const ohlcvCache = new VersionedCache(60_000);

  app.get<{ Querystring: { wallet?: string } }>('/state', async (req) => {
    const wallet = req.query.wallet;
    const wallets = await scope.wallets(req.account!.id, wallet);
    return deps.getState(wallets, wallet && wallet !== 'all' ? wallet : 'all');
  });

  // The wallet PnL curve from on-chain SOL cash-flow (captures the rug/slippage losses position-level
  // PnL misses). `wallet=all` is a true multi-wallet sum.
  app.get<{ Querystring: { wallet?: string; days?: string } }>('/wallet/pnl-curve', async (req) => {
    const days = intParam(req.query.days, 30, 1, MAX_HISTORY_DAYS);
    const wallets = await scope.wallets(req.account!.id, req.query.wallet);
    return curveCache.wrap(`curve|${req.query.wallet ?? 'all'}|${days}`, wallets, () =>
      deps.walletPnl.curve(wallets, days),
    );
  });

  // Net Worth per UTC day: on-chain cash + at-cost capital deployed in positions open that day.
  app.get<{ Querystring: { wallet?: string; days?: string } }>('/networth/curve', async (req) => {
    const days = intParam(req.query.days, 30, 1, MAX_HISTORY_DAYS);
    const wallets = await scope.wallets(req.account!.id, req.query.wallet);
    const sinceSec = days >= MAX_HISTORY_DAYS ? 0 : Math.floor((Date.now() - days * DAY_MS) / 1000);
    return curveCache.wrap(`networth|${req.query.wallet ?? 'all'}|${days}`, wallets, async () => ({
      points: await deps.networthSnapshots.reconstructedCurve(wallets, sinceSec),
    }));
  });

  app.get<{ Querystring: { wallet?: string; since?: string } }>('/stats', async (req) => {
    const since = intParam(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER);
    const wallets = await scope.wallets(req.account!.id, req.query.wallet);
    return statsCache.wrap(`stats|${req.query.wallet ?? 'all'}|${since}`, wallets, async () => ({
      scope: req.query.wallet ?? 'all',
      ...(await deps.repo.statsAggregate(wallets, since)),
      // All-time by construction: a FIFO cost-basis chain has no meaningful window.
      outsidePositionsPnlSol: await deps.walletRealized.sumFor(wallets),
    }));
  });

  app.get<{ Querystring: { wallet?: string; bucket?: string; since?: string } }>(
    '/stats/history',
    async (req) => {
      const bucket: Bucket = isBucket(req.query.bucket ?? '')
        ? (req.query.bucket as Bucket)
        : 'day';
      const since = intParam(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER);
      const wallets = await scope.wallets(req.account!.id, req.query.wallet);
      return statsCache.wrap(
        `stats-history|${req.query.wallet ?? 'all'}|${bucket}|${since}`,
        wallets,
        async () =>
          profitHistory(await deps.repo.profitBuckets(wallets, BUCKET_MS[bucket]), bucket, since),
      );
    },
  );

  // OHLCV candles for a pool's price chart. Empty ⇒ not indexed yet (the client falls back to an embed).
  app.get<{ Params: { pool: string }; Querystring: { tf?: string } }>(
    '/pools/:pool/ohlcv',
    async (req) => {
      const tf = req.query.tf ?? '15m';
      return ohlcvCache.wrap(`ohlcv|${req.params.pool}|${tf}`, [], async () => ({
        candles: await deps.ohlcv(req.params.pool, tf),
      }));
    },
  );

  // SOL spot price in USD — the client's SOL⇄USD display toggle.
  app.get('/sol-usd', async () => ({ price: await deps.solUsd().catch(() => null) }));
}
