import type { WalletPnlCurve } from '@binsight/shared';
import type { IngestCursorStore, WalletFlowRepository } from '@/domain/ports';
import { buildCashflowCurveFromDaily } from './wallet-cashflow';

const DAY_MS = 86_400_000;

/**
 * The wallet PnL curve — the realized SOL the wallet gained or lost over time, from its on-chain
 * cash-flow (it captures the rug/slippage losses position-level PnL misses). The chain is read once at
 * ingest; this is one GROUP-BY-day aggregation. `wallet=all` is a longer IN-list in the same query.
 */
export class WalletPnlService {
  constructor(
    private readonly flowRepo: Pick<WalletFlowRepository, 'dailyFlows'>,
    private readonly cursors: Pick<IngestCursorStore, 'allComplete'>,
    private readonly now: () => number = Date.now,
  ) {}

  async curve(wallets: string[], daysBack: number): Promise<WalletPnlCurve> {
    if (wallets.length === 0) {
      return { days: [], totalTradingSol: 0, totalExternalSol: 0, complete: true };
    }
    const sinceSec = Math.floor((this.now() - daysBack * DAY_MS) / 1000);
    // A wallet still backfilling makes the curve partial — the UI keeps its "indexing…" state instead
    // of presenting a half-built curve as final.
    const complete = await this.cursors.allComplete(wallets);
    const daily = await this.flowRepo.dailyFlows(wallets, sinceSec);
    return { ...buildCashflowCurveFromDaily(daily), complete };
  }
}
