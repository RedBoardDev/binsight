import type { Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

// Isolated file: we mock the (separately-tested, pure) DLMM decode/build so we can exercise makeDetectionDeps' pool-meta
// CACHE policy in isolation (#46). The defect: a null meta read (WS outran the LbPair account at the RPC replica, or a
// brand-new pool) used to be cached FOREVER — every subsequent event on that pool was then valued degraded (amounts 0 /
// nonSolMint null → routed to 'ignore') and the leader's open silently never copied (the cardinal sin). The fix caches a
// null only for a short TTL, so a later successful read re-values the pool. (Mocking the whole classify module here would
// break detection.test.ts' non-DLMM cases, hence a dedicated file.)
vi.mock('../domain/copybot/classify-dlmm-tx', () => ({
  poolsOf: (tx: unknown) => (tx ? ['POOL'] : []),
  buildDetectedEvent: (
    signature: string,
    tx: unknown,
    poolMeta: (p: string) => { mintY: string } | null,
  ) => {
    if (!tx) return null;
    const meta = poolMeta('POOL');
    return {
      signature,
      blockTime: 1,
      instruction: '(DLMM)',
      depositSol: 0,
      depositTokenRaw: 0,
      withdrawSol: 0,
      claimSol: 0,
      closed: false,
      pool: 'POOL',
      position: 'POS',
      nonSolMint: meta ? meta.mintY : null, // VALUED only once the pool meta resolves
      nonSolSymbol: null,
    };
  },
}));

import { makeDetectionDeps } from './detection';

const PK = { toBase58: () => 'LEADER' } as unknown as PublicKey;
const META = {
  mintX: 'So11111111111111111111111111111111111111112',
  mintY: 'MINT',
  solSide: 'X',
  binStep: 10,
};
const TX = {
  blockTime: 1,
  meta: { innerInstructions: [] },
  transaction: { signatures: ['x'], message: { instructions: [] } },
};
const POOL_META_NULL_TTL_MS = 15_000; // mirror the constant under test (kept in sync by these assertions)

describe('makeDetectionDeps.classify — pool-meta null cache policy (#46)', () => {
  it('a null meta read is NOT cached forever: after the TTL a later read VALUES the pool (open no longer blinded)', async () => {
    let clock = 1_000_000;
    const loadPoolMeta = vi.fn();
    loadPoolMeta.mockResolvedValueOnce(null); // 1st read: RPC replica lags the just-created LbPair → null
    loadPoolMeta.mockResolvedValue(META); // later: the pool is now readable → valuable in SOL
    const degraded: string[] = [];
    const conn = {
      getParsedTransactions: vi.fn(async (sigs: string[]) => sigs.map(() => TX)),
    } as unknown as Connection;
    const deps = makeDetectionDeps({
      conn,
      pk: PK,
      poolReader: { loadPoolMeta } as never,
      tokenMeta: { resolve: async () => new Map() } as never,
      onEvent: () => undefined,
      onPoolMetaUnavailable: (p) => degraded.push(p),
      now: () => clock,
    });

    // Read 1 — meta null → the event is valued DEGRADED (no amounts) and the operator is warned once.
    const first = await deps.classify(['s1']);
    expect(first.events.get('s1')?.nonSolMint).toBeNull();
    expect(degraded).toEqual(['POOL']);
    expect(loadPoolMeta).toHaveBeenCalledTimes(1);

    // Read 2 within the TTL — the negative cache is warm → NO re-read (don't hammer RPC), still degraded, no re-warn.
    const second = await deps.classify(['s2']);
    expect(second.events.get('s2')?.nonSolMint).toBeNull();
    expect(loadPoolMeta).toHaveBeenCalledTimes(1);
    expect(degraded).toEqual(['POOL']);

    // Advance past the TTL — the null EXPIRES → re-read → the pool is now VALUED. THE FIX: with a permanent null cache
    // this event (and every future one) would stay unvalued forever → the leader's open would be missed.
    clock += POOL_META_NULL_TTL_MS;
    const third = await deps.classify(['s3']);
    expect(loadPoolMeta).toHaveBeenCalledTimes(2); // re-read after TTL (the null was never permanent)
    expect(third.events.get('s3')?.nonSolMint).toBe('MINT'); // valued → the open is copyable again

    // Resolved metas are immutable → cached forever, no further reads.
    const fourth = await deps.classify(['s4']);
    expect(loadPoolMeta).toHaveBeenCalledTimes(2);
    expect(fourth.events.get('s4')?.nonSolMint).toBe('MINT');
  });
});
