import { describe, expect, it, vi } from 'vitest';
import type { DailyFlow, IngestCursor } from '@/domain/dlmm';
import type { IngestCursorStore, WalletFlowRepository } from '@/domain/ports';
import { WalletPnlService } from './wallet-pnl-service';

function stubFlows(daily: DailyFlow[]) {
  return {
    dailyFlows: vi.fn(async (_wallets: string[], _sinceSec: number) => daily),
  } satisfies Pick<WalletFlowRepository, 'dailyFlows'>;
}

/** In-memory ingest cursors with the same `allComplete` contract as the Postgres store: a wallet with no
 *  cursor yet (still backfilling) fails it, as does one whose history is not read to genesis. */
function stubCursors(cursors: Record<string, IngestCursor | null>) {
  return {
    allComplete: vi.fn(async (ws: string[]) => ws.every((w) => cursors[w]?.complete === true)),
  } satisfies Pick<IngestCursorStore, 'allComplete'>;
}

const complete = (): IngestCursor => ({ oldestSig: 'g', newestSig: 'n', complete: true });

describe('WalletPnlService.curve', () => {
  it('aggregates ALL passed wallets and queries them together (wallet=all is a real SUM)', async () => {
    const flows = stubFlows([{ date: '2026-06-01', trading: 7, external: 0 }]);
    const cursors = stubCursors({ w1: complete(), w2: complete() });
    const now = () => Date.UTC(2026, 5, 10, 12);
    const res = await new WalletPnlService(flows, cursors, now).curve(['w1', 'w2'], 30);

    expect(flows.dailyFlows).toHaveBeenCalledTimes(1);
    const [wallets, sinceSec] = flows.dailyFlows.mock.calls[0]!;
    expect(wallets).toEqual(['w1', 'w2']);
    expect(sinceSec).toBe(Math.floor((now() - 30 * 86_400_000) / 1000));
    // Completeness is asked for the whole set at once (one COUNT in Postgres, not N lookups).
    expect(cursors.allComplete).toHaveBeenCalledWith(['w1', 'w2']);
    expect(res.totalTradingSol).toBe(7);
    expect(res.complete).toBe(true);
  });

  it('complete=false while any wallet is still backfilling (cursor missing or not complete)', async () => {
    // The UI keeps its "indexing…" state on complete=false — a half-built curve must never read as final.
    const flows = stubFlows([]);
    const stillBackfilling = stubCursors({ w1: complete(), w2: null });
    expect(
      (await new WalletPnlService(flows, stillBackfilling).curve(['w1', 'w2'], 30)).complete,
    ).toBe(false);

    const partial = stubCursors({ w1: { oldestSig: 'g', newestSig: 'n', complete: false } });
    expect((await new WalletPnlService(flows, partial).curve(['w1'], 30)).complete).toBe(false);
  });

  it('returns an empty, complete curve for an empty wallet set', async () => {
    const flows = stubFlows([]);
    const cursors = stubCursors({});
    const res = await new WalletPnlService(flows, cursors).curve([], 30);
    expect(res).toEqual({ days: [], totalTradingSol: 0, totalExternalSol: 0, complete: true });
    // Short-circuits: no query at all for nothing to show.
    expect(flows.dailyFlows).not.toHaveBeenCalled();
    expect(cursors.allComplete).not.toHaveBeenCalled();
  });
});
