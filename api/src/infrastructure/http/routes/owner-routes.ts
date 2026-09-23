import {
  EventKindSchema,
  type LiveEvent,
  NotifRuleSchema,
  RuntimeSettingsSchema,
} from '@binsight/shared';
import type { CreditMeter } from '@binsight/solana-core';
import type { FastifyInstance } from 'fastify';
import type { WatchlistService } from '@/application/accounts/watchlist-service';
import type { EventBus } from '@/application/event-bus';
import type { NotificationManager } from '@/application/notification/manager';
import type { AccountRepository, ConfigRepository } from '@/domain/ports';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';
import type { RpcCreditLedgerRepository } from '@/infrastructure/persistence/rpc-credit-ledger-repository';
import { isValidSolanaAddress } from '../auth';

export interface OwnerRouteDeps {
  bus: EventBus;
  accounts: AccountRepository;
  watchlist: WatchlistService;
  configRepo: ConfigRepository;
  notifications: NotificationManager;
  presence: PresenceTracker;
  meter: CreditMeter;
  creditLedger: RpcCreditLedgerRepository;
  refreshNow(): void;
  ingestStatus(address: string): { ready: boolean; indexedTxs: number };
}

/** How many recent UTC days of persisted credit spend /debug/rpc returns. */
const DEBUG_RPC_HISTORY_DAYS = 7;

/**
 * Operations, notification rules and access management. Registered as one encapsulated plugin whose
 * hook refuses anyone but the owner, so a route added here can never be left ungated by mistake.
 */
export async function registerOwnerRoutes(app: FastifyInstance, deps: OwnerRouteDeps) {
  const { accounts, configRepo } = deps;

  await app.register(async (owner) => {
    owner.addHook('preHandler', async (req, reply) => {
      if (!req.account?.isOwner) return reply.code(403).send({ error: 'forbidden' });
    });

    // Fires a fake event through the normal path — verifies notifications end to end.
    owner.post('/debug/notify', async (req) => {
      const kind =
        EventKindSchema.safeParse((req.query as Record<string, string>).kind).data ??
        'position_close';
      const ev: LiveEvent = {
        id: `test-${Date.now()}`,
        kind,
        wallet: null,
        positionAddress: null,
        pair: 'SOL/USDC',
        title: kind === 'position_close' ? 'Position closed — SOL/USDC' : 'Test notification',
        body: kind === 'position_close' ? '+0.0420 SOL · fees 0.0012' : 'Notifications work ✅',
        data: {},
        createdAt: Date.now(),
      };
      deps.bus.emit('event', ev);
      const activeDevices = deps.presence.activeDevices();
      return {
        ok: true,
        kind,
        activeDevices,
        willRoute: activeDevices.length > 0 ? 'native' : 'bark',
      };
    });

    // RPC credit telemetry: the in-memory ledger, its anomaly signals and the persisted daily spend.
    owner.get('/debug/rpc', async () => ({
      stats: deps.meter.stats(),
      anomalies: deps.meter.anomalies(),
      last7d: await deps.creditLedger.since(DEBUG_RPC_HISTORY_DAYS),
    }));

    // Manual force-refresh of every monitored wallet.
    owner.post('/refresh', async () => {
      deps.refreshNow();
      return { ok: true };
    });

    owner.get('/config/notifications', async () => configRepo.listNotifRules());

    owner.put('/config/notifications', async (req, reply) => {
      const rule = NotifRuleSchema.safeParse(req.body);
      if (!rule.success) return reply.code(400).send({ error: rule.error.format() });
      await configRepo.saveNotifRule(rule.data);
      deps.notifications.reloadRules();
      return { ok: true };
    });

    // Runtime settings (the Bark key), changeable without a redeploy.
    owner.get('/config/settings', async () => configRepo.getSettings());

    owner.put('/config/settings', async (req, reply) => {
      const parsed = RuntimeSettingsSchema.partial().safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
      return configRepo.saveSettings(parsed.data);
    });

    // One list over invites (whitelist) + accounts; one revoke removes both so access truly ends.
    owner.get('/admin/access', async () => accounts.listAccess());

    owner.post<{ Body: { address?: unknown; note?: unknown } }>(
      '/admin/access',
      async (req, reply) => {
        const address = req.body?.address;
        if (!isValidSolanaAddress(address)) {
          return reply.code(400).send({ error: 'invalid Solana address' });
        }
        await accounts.addWhitelist({
          address,
          note: (typeof req.body?.note === 'string' ? req.body.note : '').slice(0, 200),
          addedBy: req.account!.address,
        });
        return { ok: true };
      },
    );

    // Revoke: delete the account (if any) AND the invite. Shared wallet data is kept; wallets left with
    // no watcher stop being monitored.
    owner.delete<{ Params: { address: string } }>('/admin/access/:address', async (req, reply) => {
      const found = await accounts.findByAddress(req.params.address);
      if (found?.user.isOwner) return reply.code(400).send({ error: 'cannot revoke the owner' });
      const stoppedMonitoring = found ? await deps.watchlist.deleteAccount(found.user.id) : 0;
      await accounts.removeWhitelist(req.params.address);
      return { ok: true, stoppedMonitoring };
    });

    // Every monitored wallet: watchers, open/closed counts, last sync, live ingest status.
    owner.get('/admin/wallets', async () => {
      const rows = await accounts.walletOverview();
      return rows.map((w) => ({ ...w, ...deps.ingestStatus(w.address) }));
    });
  });
}
