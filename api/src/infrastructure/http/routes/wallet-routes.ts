import { WalletSchema } from '@binsight/shared';
import type { FastifyInstance } from 'fastify';
import type { WatchlistService } from '@/application/accounts/watchlist-service';
import type { AccountRepository } from '@/domain/ports';
import { isValidSolanaAddress } from '../auth';

export interface WalletRouteDeps {
  accounts: AccountRepository;
  watchlist: WatchlistService;
  /** Onboarding status of a wallet: `ready` once its history is queryable. */
  ingestStatus(address: string): { ready: boolean; indexedTxs: number };
}

/** The caller's watchlist. */
export function registerWalletRoutes(app: FastifyInstance, deps: WalletRouteDeps): void {
  const { accounts, watchlist } = deps;

  // Enriched with onboarding status so the UI can show "indexing…" while a new wallet backfills.
  app.get('/wallets', async (req) => {
    const watched = await accounts.watchedBy(req.account!.id);
    return watched.map((w) => ({ ...w, ...deps.ingestStatus(w.address) }));
  });

  app.post('/wallets', async (req, reply) => {
    const body = WalletSchema.partial({ createdAt: true, label: true }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.format() });
    const { address, label, color } = body.data;
    // The schema only checks the alphabet; reject what isn't a real key before it costs a backfill.
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ error: 'invalid Solana address' });
    }
    const result = await watchlist.add(req.account!, { address, label: label ?? '', color });
    if (result.ok) return { ok: true };
    if (result.reason === 'account-limit') {
      return reply.code(409).send({ error: `wallet limit reached (${result.limit})` });
    }
    return reply.code(503).send({ error: 'capacity reached, try later' });
  });

  app.delete<{ Params: { address: string } }>('/wallets/:address', async (req, reply) => {
    // The registration address IS the account identity: it can't be unwatched.
    if (req.params.address === req.account!.address) {
      return reply.code(400).send({ error: 'cannot remove your account wallet' });
    }
    await watchlist.remove(req.account!.id, req.params.address);
    return { ok: true };
  });
}
