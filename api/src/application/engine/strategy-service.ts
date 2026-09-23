import type { Logger } from 'pino';
import type { PositionStore, StrategyResolver } from '@/domain/ports';
import { withCodePath } from '@/infrastructure/solana/code-path';
import { sleep } from '@/util/sleep';

const BACKFILL_PAUSE_MS = 400; // gentle pacing for the historical backfill (~2-3 positions/s of RPC)

/**
 * Resolves each OPEN position's strategy family (Spot/Curve/BidAsk) once from its on-chain open tx and
 * persists it, so it survives restarts and travels with the position into closed history.
 */
export class StrategyService {
  private readonly attempted = new Set<string>();
  private backfilling = false;

  constructor(
    private readonly resolver: StrategyResolver,
    private readonly repo: Pick<PositionStore, 'addressesMissingStrategy' | 'setStrategy'>,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolve strategy for OPEN positions still missing it (the repo now returns open-only) — so the live
   * card/badge gets its Spot/Curve/BidAsk tag even when the burst one-shot live resolution lost to RPC
   * limits. Closed positions are NOT bulk-backfilled: re-paging tens of thousands of closed positions'
   * open txs (getParsedTransaction) burned millions of credits for a label on already-closed rows. A
   * position resolved while open keeps its strategy into closed history; old closed rows show no badge.
   * Bounded per run and paced so it never hammers the RPC; safe on a schedule.
   */
  async backfill(maxPerRun = 60): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      const candidates = await this.repo.addressesMissingStrategy(maxPerRun * 4);
      const todo = candidates.filter((a) => !this.attempted.has(a)).slice(0, maxPerRun);
      for (const addr of todo) {
        await this.resolve(addr);
        await sleep(BACKFILL_PAUSE_MS);
      }
      if (todo.length > 0)
        this.logger.info({ resolved: todo.length }, 'strategy backfill pass done');
    } finally {
      this.backfilling = false;
    }
  }

  private async resolve(positionAddress: string): Promise<void> {
    this.attempted.add(positionAddress);
    try {
      // Tag the resolver's getSignaturesForAddress + getParsedTransaction spend.
      const family = await withCodePath('strategy', () => this.resolver.resolve(positionAddress));
      if (family) await this.repo.setStrategy(positionAddress, family);
    } catch (err) {
      this.attempted.delete(positionAddress); // transient failure — let a later poll retry
      this.logger.debug({ err, positionAddress }, 'strategy resolution failed (will retry)');
    }
  }
}
