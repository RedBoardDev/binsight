import type { Candle, PositionBins, PositionHistory } from '@binsight/shared';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { WatchlistService } from '@/application/accounts/watchlist-service';
import type { Engine } from '@/application/engine';
import type { EventBus } from '@/application/event-bus';
import type { NotificationManager } from '@/application/notification/manager';
import type { WalletPnlService } from '@/application/wallet-pnl-service';
import type { AppConfig } from '@/config/env';
import type {
  AccountRepository,
  ConfigRepository,
  PositionQueries,
  PositionStore,
  WalletRealizedStore,
} from '@/domain/ports';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';
import type { NetworthSnapshotRepository } from '@/infrastructure/persistence/networth-snapshot-repository';
import type { PushRepository } from '@/infrastructure/persistence/push-repository';
import type { RpcCreditLedgerRepository } from '@/infrastructure/persistence/rpc-credit-ledger-repository';
import type { CreditMeter } from '@/infrastructure/solana/credit-meter';
import { verifyJwt } from './auth';
import { registerAuthRoutes } from './routes/auth-routes';
import { WatchScope } from './routes/context';
import { registerOwnerRoutes } from './routes/owner-routes';
import { registerPortfolioRoutes } from './routes/portfolio-routes';
import { registerPositionRoutes } from './routes/position-routes';
import { registerPushRoutes } from './routes/push-routes';
import { registerWalletRoutes } from './routes/wallet-routes';
import { registerWebSocket } from './websocket';

declare module 'fastify' {
  interface FastifyRequest {
    account?: { id: string; isOwner: boolean; address: string; tokenVersion: number; jti: string };
  }
}

export interface ServerDeps {
  config: AppConfig;
  bus: EventBus;
  engine: Pick<
    Engine,
    'getState' | 'ingestStatus' | 'refreshNow' | 'healthSnapshot' | 'setViewedWallets'
  >;
  accounts: AccountRepository;
  watchlist: WatchlistService;
  store: PositionStore;
  queries: PositionQueries;
  configRepo: ConfigRepository;
  notifications: NotificationManager;
  presence: PresenceTracker;
  walletPnl: WalletPnlService;
  networthSnapshots: NetworthSnapshotRepository;
  walletRealized: WalletRealizedStore;
  pushRepo: PushRepository;
  meter: CreditMeter;
  creditLedger: RpcCreditLedgerRepository;
  positionBins(address: string): Promise<PositionBins | null>;
  positionHistory(address: string): Promise<PositionHistory | null>;
  ohlcv(pool: string, timeframe: string): Promise<Candle[]>;
  solUsd(): Promise<number | null>;
  sendTestPush(userId: string): Promise<number>;
}

export async function buildServer(deps: ServerDeps) {
  const { config, accounts } = deps;
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  const webOrigins = config.WEB_ORIGINS.split(',').map((o) => o.trim());
  const openAccess = config.OPEN_ACCESS_MODE;

  // Allowlist for browsers — auth is the real boundary; this is defence in depth.
  await app.register(cors, { origin: webOrigins });
  // Client frames are tiny (subscribe/presence/ping): 1 MB caps a hostile one. Server frames are
  // repetitive JSON state snapshots, which permessage-deflate shrinks several-fold.
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024, perMessageDeflate: { threshold: 1024 } },
  });

  // Log the real error, return a clean shape (no stack/internals leaked).
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request error');
    const statusCode = (err as { statusCode?: number }).statusCode;
    const status = typeof statusCode === 'number' && statusCode >= 400 ? statusCode : 500;
    const message = err instanceof Error ? err.message : 'error';
    reply.code(status).send({ error: status >= 500 ? 'internal error' : message });
  });

  // Deny by default: every route needs a session JWT unless it is declared `public`. A token whose
  // version is stale (a reset bumped it) or whose session was revoked is refused, and so is a
  // WebSocket ticket — it only opens /live.
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.config?.public) return;
    const auth = req.headers.authorization;
    const payload = auth?.startsWith('Bearer ')
      ? verifyJwt(config.AUTH_SECRET, auth.slice(7))
      : null;
    const user =
      payload && payload.aud !== 'ws'
        ? await accounts.findByIdWithSession(payload.sub, payload.jti)
        : null;
    if (!payload || !user || user.tokenVersion !== payload.ver) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    req.account = {
      id: user.id,
      isOwner: user.isOwner,
      address: user.address,
      tokenVersion: user.tokenVersion,
      jti: payload.jti,
    };
  });

  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));

  const scope = new WatchScope(accounts);
  deps.watchlist.onChange((userId) => scope.invalidate(userId));

  registerAuthRoutes(app, {
    secret: config.AUTH_SECRET,
    primaryOrigin: webOrigins[0] || 'http://localhost:3000',
    ownerAddress: config.OWNER_ADDRESS,
    openAccess,
    accounts,
    watchlist: deps.watchlist,
  });
  registerWalletRoutes(app, {
    accounts,
    watchlist: deps.watchlist,
    ingestStatus: (a) => deps.engine.ingestStatus(a),
  });
  registerPortfolioRoutes(app, {
    bus: deps.bus,
    scope,
    getState: (wallets, s) => deps.engine.getState(wallets, s),
    repo: deps.queries,
    walletPnl: deps.walletPnl,
    networthSnapshots: deps.networthSnapshots,
    walletRealized: deps.walletRealized,
    ohlcv: deps.ohlcv,
    solUsd: deps.solUsd,
  });
  registerPositionRoutes(app, {
    scope,
    accounts,
    repo: deps.queries,
    positionBins: deps.positionBins,
    positionHistory: deps.positionHistory,
    solUsd: deps.solUsd,
  });
  registerPushRoutes(app, {
    pushRepo: deps.pushRepo,
    vapidPublicKey: config.VAPID_PUBLIC_KEY,
    sendTestPush: deps.sendTestPush,
    openAccess,
  });
  await registerOwnerRoutes(app, {
    bus: deps.bus,
    accounts,
    watchlist: deps.watchlist,
    configRepo: deps.configRepo,
    notifications: deps.notifications,
    presence: deps.presence,
    meter: deps.meter,
    creditLedger: deps.creditLedger,
    refreshNow: () => deps.engine.refreshNow(),
    ingestStatus: (a) => deps.engine.ingestStatus(a),
  });
  registerWebSocket(app, {
    secret: config.AUTH_SECRET,
    engine: deps.engine,
    bus: deps.bus,
    presence: deps.presence,
    accounts,
    allowedOrigins: webOrigins,
  });

  return app;
}
