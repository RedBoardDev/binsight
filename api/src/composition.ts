import { pino } from 'pino';
import { WatchlistService } from './application/accounts/watchlist-service';
import { DlmmPositionPnl } from './application/dlmm-position-pnl';
import { Engine } from './application/engine/index';
import { StrategyService } from './application/engine/strategy-service';
import { EventBus } from './application/event-bus';
import { HealthMonitor } from './application/health-monitor';
import { NetworthRecorder } from './application/networth-recorder';
import { NotificationManager } from './application/notification/manager';
import { PositionSync } from './application/position-sync-service';
import { RealizedPnlEngine } from './application/realized-pnl';
import { WalletPnlService } from './application/wallet-pnl-service';
import type { AppConfig } from './config/env';
import { GeckoTerminalGateway } from './infrastructure/geckoterminal/geckoterminal-gateway';
import { installGracefulShutdown } from './infrastructure/http/graceful-shutdown';
import { buildServer } from './infrastructure/http/server';
import { CachedPriceGateway } from './infrastructure/jupiter/cached-price-gateway';
import { JupiterPriceGateway } from './infrastructure/jupiter/jupiter-price';
import { BarkChannel } from './infrastructure/notifications/bark-channel';
import { PresenceTracker } from './infrastructure/notifications/presence';
import { WebPushChannel } from './infrastructure/notifications/web-push-channel';
import { PostgresAccountRepository } from './infrastructure/persistence/account-repository';
import { PostgresConfigRepository } from './infrastructure/persistence/config-repository';
import { closeDatabase, openDatabase, runMigrations } from './infrastructure/persistence/database';
import { DlmmLegRepository } from './infrastructure/persistence/dlmm-leg-repository';
import { PostgresIngestCursorRepository } from './infrastructure/persistence/ingest-cursor-repository';
import { NetworthSnapshotRepository } from './infrastructure/persistence/networth-snapshot-repository';
import { PostgresPositionQueries } from './infrastructure/persistence/position-queries';
import { PostgresPositionStore } from './infrastructure/persistence/position-store';
import { PushRepository } from './infrastructure/persistence/push-repository';
import { RpcCreditLedgerRepository } from './infrastructure/persistence/rpc-credit-ledger-repository';
import { SwapFlowRepository } from './infrastructure/persistence/swap-flow-repository';
import { WalletFlowRepository } from './infrastructure/persistence/wallet-flow-repository';
import { WalletRealizedRepository } from './infrastructure/persistence/wallet-realized-repository';
import { CreditMeter } from './infrastructure/solana/credit-meter';
import { OnchainDlmmGateway } from './infrastructure/solana/dlmm/onchain-gateway';
import { OnchainPoolMetaReader } from './infrastructure/solana/dlmm/pool-meta';
import { StrategyResolver } from './infrastructure/solana/dlmm/strategy-resolver';
import { createHeliusWsTransportFactory } from './infrastructure/solana/helius-ws-transport';
import { createRpcLanes, RPS_SAFETY } from './infrastructure/solana/rpc-lanes';
import { HeliusTokenMetadataGateway } from './infrastructure/solana/token-metadata-gateway';
import { TransactionStream } from './infrastructure/solana/transaction-stream';
import { WalletTxIngest } from './infrastructure/solana/wallet-tx-ingest';

/** Flush the credit meter's deltas into the rpc_credit_daily rollup, and log the counters, this often. */
const CREDIT_FLUSH_INTERVAL_MS = 60_000;

export interface App {
  start(): Promise<void>;
}

export function compose(config: AppConfig): App {
  const logger = pino({ level: config.LOG_LEVEL });
  const db = openDatabase(config.DATABASE_URL);

  // ── Persistence ──
  const positionStore = new PostgresPositionStore(db);
  const positionQueries = new PostgresPositionQueries(db);
  const accounts = new PostgresAccountRepository(db);
  const configRepo = new PostgresConfigRepository(db, { barkKey: config.BARK_KEY });
  const legRepo = new DlmmLegRepository(db);
  const walletFlowRepo = new WalletFlowRepository(db);
  const swapFlowRepo = new SwapFlowRepository(db);
  const ingestCursors = new PostgresIngestCursorRepository(db);
  const walletRealized = new WalletRealizedRepository(db);
  const networthSnapshots = new NetworthSnapshotRepository(db);
  const pushRepo = new PushRepository(db);
  const creditLedger = new RpcCreditLedgerRepository(db);

  const bus = new EventBus();
  const health = new HealthMonitor();

  // ── Chain access: every billable call goes through ONE credit meter (the ledger behind /debug/rpc) ──
  const meter = new CreditMeter();
  const rpc = createRpcLanes(
    config.solanaHttpUrl,
    {
      rps: config.SOLANA_RPS,
      gpaRps: config.SOLANA_GPA_RPS,
      dasRps: config.SOLANA_DAS_RPS,
      sendRps: config.SOLANA_SEND_RPS,
      liveFraction: config.SOLANA_LIVE_FRACTION,
    },
    meter,
  );
  // Per-mint price cache + single-flight: viewers and wallets needing the same token share one call.
  const prices = new CachedPriceGateway(
    new JupiterPriceGateway(logger, config.JUPITER_PRICE_URL, health),
  );
  // The WS backbone opens its socket only when the engine starts it.
  const stream = new TransactionStream({
    transportFactory: createHeliusWsTransportFactory(config.SOLANA_WS_URL, meter),
    logger,
  });
  const onchain = new OnchainDlmmGateway(rpc.live);
  // The DAS budget belongs to the metadata gateway (the Connections issue no DAS calls).
  const tokenMetadata = new HeliusTokenMetadataGateway(config.solanaHttpUrl, logger, {
    dasRps: config.SOLANA_DAS_RPS * RPS_SAFETY,
    meter,
  });

  // ── The wallet pipeline: ingest → projection → realized PnL (all on the backfill lane but snapshots) ──
  const walletTxIngest = new WalletTxIngest(
    rpc.backfill,
    legRepo,
    walletFlowRepo,
    swapFlowRepo,
    ingestCursors,
    logger,
    { sinceDays: config.INGEST_SINCE_DAYS },
  );
  const positionSync = new PositionSync(
    new DlmmPositionPnl(legRepo, new OnchainPoolMetaReader(rpc.backfill), logger),
    tokenMetadata,
    positionStore,
    logger,
  );
  const realizedPnl = new RealizedPnlEngine(
    legRepo,
    positionStore,
    swapFlowRepo,
    ingestCursors,
    (mints) => onchain.decimalsOfMany(mints),
    logger,
  );
  const engine = new Engine({
    prices,
    stream,
    onchain,
    health,
    strategy: new StrategyService(new StrategyResolver(rpc.live), positionStore, logger),
    store: positionStore,
    accounts,
    bus,
    logger,
    walletTxIngest,
    positionSync,
    realizedPnl,
    walletRealized,
    backfillConcurrency: config.BACKFILL_CONCURRENCY,
    realizedPnlEnabled: config.REALIZED_PNL_ENABLED,
  });
  const watchlist = new WatchlistService(accounts, engine, config.OPEN_ACCESS_MODE);

  // ── Notifications: Web Push per account, native banner on an active client, else Bark ──
  const presence = new PresenceTracker(config.PRESENCE_TIMEOUT_SECONDS * 1000);
  const webPush = new WebPushChannel(
    pushRepo,
    {
      publicKey: config.VAPID_PUBLIC_KEY,
      privateKey: config.VAPID_PRIVATE_KEY,
      subject: config.VAPID_SUBJECT,
    },
    logger,
  );
  const notifications = new NotificationManager(
    bus,
    configRepo,
    presence,
    new BarkChannel(config.BARK_BASE_URL, () => configRepo.getSettings().barkKey, logger),
    webPush,
    logger,
  );
  // Forward-only Net Worth history, sampled from exact snapshots only.
  const networthRecorder = new NetworthRecorder(bus, networthSnapshots, logger);
  const gecko = new GeckoTerminalGateway(logger);

  return {
    async start() {
      await runMigrations(db, './drizzle');
      // Resync the daily cash-flow rollup from the raw flows (cheap, idempotent).
      await walletFlowRepo.rebuildDaily();
      await configRepo.init();
      await accounts.init(config.OWNER_ADDRESS);
      notifications.start();
      networthRecorder.start();
      await engine.start();
      const server = await buildServer({
        config,
        bus,
        engine,
        accounts,
        watchlist,
        store: positionStore,
        queries: positionQueries,
        configRepo,
        notifications,
        presence,
        walletPnl: new WalletPnlService(walletFlowRepo, ingestCursors),
        networthSnapshots,
        walletRealized,
        pushRepo,
        meter,
        creditLedger,
        positionBins: (a) => onchain.positionBins(a),
        positionHistory: (a) => onchain.positionHistory(a),
        ohlcv: (pool, tf) => gecko.ohlcv(pool, tf),
        solUsd: () => prices.getSolUsd(),
        sendTestPush: (userId) => pushRepo.forUser(userId).then((subs) => webPush.sendTest(subs)),
      });

      // Persist the credit meter's deltas so /debug/rpc keeps its spend history across restarts, and
      // log the in-process counters for tier-headroom monitoring.
      const flush = setInterval(() => {
        logger.info({ rpc: rpc.stats(), credits: meter.stats() }, 'rpc call counts');
        const deltas = meter.drainForFlush();
        if (deltas.length > 0) void creditLedger.addDeltas(deltas);
      }, CREDIT_FLUSH_INTERVAL_MS);

      // The db closes last (after in-flight requests drain); the engine stops first. Hooks must be
      // registered before listen.
      server.addHook('onClose', async () => closeDatabase(db));
      installGracefulShutdown(server, {
        closeHandlers: [async () => engine.stop(), async () => clearInterval(flush)],
      });
      await server.listen({ port: config.PORT, host: '0.0.0.0' });
      logger.info({ port: config.PORT }, 'Binsight API listening');
    },
  };
}
