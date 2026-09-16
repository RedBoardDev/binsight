import type { WalletState } from '@binsight/shared';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { NetworthRecorder, type NetworthSnapshotStore } from './networth-recorder';

function stateFor(
  scope: string,
  totals: { walletTotalSol: number; tvlSol: number; idleSol: number },
  freshness: 'fresh' | 'syncing' = 'fresh',
) {
  return {
    scope,
    totals: { ...totals },
    openPositions: [],
    asOfSlot: null,
    freshness,
    updatedAt: Date.now(),
  } as unknown as WalletState;
}

/** A bus stub that captures the 'state' handler so a test can drive it synchronously. */
function busStub() {
  let handler: ((s: WalletState) => void) | undefined;
  return {
    on: (_type: 'state', h: (s: WalletState) => void) => {
      handler = h;
      return () => {};
    },
    emit: async (s: WalletState) => {
      handler?.(s);
      // onState is async (fire-and-forget from the handler); let its microtasks settle.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function deps() {
  const snapRepo: NetworthSnapshotStore & { record: ReturnType<typeof vi.fn> } = {
    record: vi.fn(async () => {}),
  };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger & {
    error: ReturnType<typeof vi.fn>;
  };
  return { snapRepo, logger };
}

describe('NetworthRecorder', () => {
  it('records the wallet total from the state payload', async () => {
    const { snapRepo, logger } = deps();
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, logger).start();

    await bus.emit(stateFor('walletA', { walletTotalSol: 12, tvlSol: 8, idleSol: 4 }));

    expect(snapRepo.record).toHaveBeenCalledTimes(1);
    const [wallet, p] = snapRepo.record.mock.calls[0]!;
    expect(wallet).toBe('walletA');
    expect(p).toMatchObject({ walletTotalSol: 12, tvlSol: 8, idleSol: 4 });
    expect(typeof p.ts).toBe('number');
  });

  it('throttles to one snapshot per wallet per 15-min bucket', async () => {
    const { snapRepo, logger } = deps();
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, logger).start();

    await bus.emit(stateFor('walletA', { walletTotalSol: 1, tvlSol: 1, idleSol: 0 }));
    await bus.emit(stateFor('walletA', { walletTotalSol: 2, tvlSol: 2, idleSol: 0 }));
    // a DIFFERENT wallet is not throttled by walletA's bucket.
    await bus.emit(stateFor('walletB', { walletTotalSol: 9, tvlSol: 9, idleSol: 0 }));

    expect(snapRepo.record).toHaveBeenCalledTimes(2);
    expect(snapRepo.record.mock.calls.map((c) => c[0])).toEqual(['walletA', 'walletB']);
  });

  it('skips an incomplete valuation (freshness !== "fresh") WITHOUT consuming the bucket', async () => {
    const { snapRepo, logger } = deps();
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, logger).start();

    // An incomplete snapshot (missing price / null bin-array / unknown decimals → 'syncing') would
    // deflate/inflate the wallet total — it must NOT be persisted as a Net Worth point.
    await bus.emit(stateFor('walletA', { walletTotalSol: 3, tvlSol: 3, idleSol: 0 }, 'syncing'));
    expect(snapRepo.record).not.toHaveBeenCalled();

    // …and skipping must NOT consume walletA's 15-min bucket: the next FRESH sample in the same bucket
    // records the real number. (Guards against placing the freshness gate after the bucket throttle.)
    await bus.emit(stateFor('walletA', { walletTotalSol: 7, tvlSol: 7, idleSol: 0 }, 'fresh'));
    expect(snapRepo.record).toHaveBeenCalledTimes(1);
    expect(snapRepo.record.mock.calls[0]![1]).toMatchObject({ walletTotalSol: 7 });
  });

  it('ignores the aggregated "all" scope (never persisted under a non-address key)', async () => {
    const { snapRepo, logger } = deps();
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, logger).start();

    await bus.emit(stateFor('all', { walletTotalSol: 100, tvlSol: 60, idleSol: 40 }));

    expect(snapRepo.record).not.toHaveBeenCalled();
  });
});
