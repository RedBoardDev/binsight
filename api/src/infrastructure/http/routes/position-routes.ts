import type { ClosedPosition, PositionBins, PositionHistory } from '@binsight/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AccountRepository, ClosedQuery, PositionQueries } from '@/domain/ports';
import { renderClosedPnlCard } from '@/infrastructure/share-card/pnl-card';
import { intParam, type WatchScope } from './context';

export interface PositionRouteDeps {
  scope: WatchScope;
  accounts: Pick<AccountRepository, 'isWatching'>;
  repo: Pick<PositionQueries, 'getClosed' | 'getClosedByAddress' | 'walletOfPosition'>;
  positionBins(address: string): Promise<PositionBins | null>;
  positionHistory(address: string): Promise<PositionHistory | null>;
  solUsd(): Promise<number | null>;
}

/** Page size cap of the paginated history; the CSV export has its own, larger one. */
const MAX_PAGE_SIZE = 100;
// An unbounded export would allocate hundreds of MB and block the event loop for everyone; 50k covers
// any realistic history, beyond that the paginated endpoint is the path.
const CSV_MAX_ROWS = 50_000;

type ClosedFilterQuery = { q?: string; sort?: string; dir?: string; result?: string };

function closedFilter(query: ClosedFilterQuery): Omit<ClosedQuery, 'page' | 'pageSize'> {
  return {
    q: query.q?.trim() || undefined,
    sort:
      (['recent', 'pnl', 'fees', 'duration'] as const).find((s) => s === query.sort) ?? 'recent',
    dir: query.dir === 'asc' ? 'asc' : 'desc',
    result: (['win', 'loss'] as const).find((r) => r === query.result) ?? 'all',
  };
}

/** One CSV cell. Text that a spreadsheet would run as a formula (token symbols are chosen by whoever
 *  minted the token) is prefixed with a quote so it stays text. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');

function csvOf(rows: ClosedPosition[]): string {
  const lines = [
    'Pair,Strategy,Quote,Invested Quote,Withdrawn Quote,Fees Quote,PnL Quote,PnL %,Opened,Closed,Duration s,Position',
  ];
  for (const r of rows) {
    // Every amount is in the position's own quote, named by the Quote column.
    lines.push(
      [
        `${r.tokenX}/${r.tokenY}`,
        r.strategy ?? '',
        r.quoteSymbol,
        r.depositQuote,
        r.withdrawQuote,
        r.feesQuote,
        r.pnlQuote,
        r.pnlPctQuote,
        iso(r.openedAt),
        iso(r.closedAt),
        r.durationSeconds,
        r.positionAddress,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

/** Closed history, CSV export, and per-position detail. A position is readable only when the caller
 *  watches its wallet (404, not 403, so existence is never confirmed). */
export function registerPositionRoutes(app: FastifyInstance, deps: PositionRouteDeps): void {
  const { scope, repo, accounts } = deps;

  const ownsPosition = async (userId: string, address: string): Promise<boolean> => {
    const wallet = await repo.walletOfPosition(address);
    return wallet != null && (await accounts.isWatching(userId, wallet));
  };

  /** An on-chain read for a watched position: 404 when not ours or absent, 502 on an RPC failure. */
  const onchainRead = async <T>(
    userId: string,
    address: string,
    reply: FastifyReply,
    read: () => Promise<T | null>,
    missing: string,
  ) => {
    if (!(await ownsPosition(userId, address))) {
      return reply.code(404).send({ error: 'position not found' });
    }
    try {
      const value = await read();
      return value ?? reply.code(404).send({ error: missing });
    } catch (err) {
      reply.log.warn({ err, address }, 'on-chain position read failed');
      return reply.code(502).send({ error: 'upstream RPC error' });
    }
  };

  app.get<{
    Querystring: ClosedFilterQuery & { wallet?: string; page?: string; pageSize?: string };
  }>('/positions/closed', async (req) => {
    const wallets = await scope.wallets(req.account!.id, req.query.wallet);
    return repo.getClosed(wallets, {
      ...closedFilter(req.query),
      page: intParam(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER),
      pageSize: intParam(req.query.pageSize, 20, 1, MAX_PAGE_SIZE),
    });
  });

  // Full closed-history CSV of the current filter (cookie-authed, fetched via <a download>).
  app.get<{ Querystring: ClosedFilterQuery & { wallet?: string } }>(
    '/positions/closed.csv',
    async (req, reply) => {
      const wallets = await scope.wallets(req.account!.id, req.query.wallet);
      const { rows } = await repo.getClosed(wallets, {
        ...closedFilter(req.query),
        page: 1,
        pageSize: CSV_MAX_ROWS,
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="binsight-closed-positions.csv"')
        .send(csvOf(rows));
    },
  );

  app.get<{ Params: { address: string } }>('/positions/:address/bins', async (req, reply) =>
    onchainRead(
      req.account!.id,
      req.params.address,
      reply,
      () => deps.positionBins(req.params.address),
      'position not found or closed',
    ),
  );

  app.get<{ Params: { address: string } }>('/positions/:address/history', async (req, reply) =>
    onchainRead(
      req.account!.id,
      req.params.address,
      reply,
      () => deps.positionHistory(req.params.address),
      'no history for this position',
    ),
  );

  app.get<{ Params: { address: string } }>('/positions/:address', async (req) => {
    const closed = await repo.getClosedByAddress(req.params.address);
    if (closed && !(await accounts.isWatching(req.account!.id, closed.wallet))) {
      return { closed: null };
    }
    return { closed };
  });

  // PnL share card (PNG) for a closed position the caller watches.
  app.get<{ Params: { address: string } }>('/positions/:address/card.png', async (req, reply) => {
    const closed = await repo.getClosedByAddress(req.params.address);
    if (!closed || !(await accounts.isWatching(req.account!.id, closed.wallet))) {
      return reply.code(404).send({ error: 'closed position not found' });
    }
    const png = await renderClosedPnlCard(closed, await deps.solUsd().catch(() => null));
    return reply.type('image/png').header('cache-control', 'private, max-age=60').send(png);
  });
}
