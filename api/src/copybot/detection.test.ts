import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { utils } from '@coral-xyz/anchor';
import type { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { chunk, makeDetectionDeps } from './detection';

// detection.ts is the I/O adapter feeding the no-miss LeaderDetector. The logic that MATTERS here is the no-miss
// completeness of signature ingestion: cold-start is bounded (no full-wallet replay); a poll does a COMPLETE
// contiguous sweep of everything newer than the cursor (paginating with `before`), drops only failed txs, and —
// crucially — THROWS rather than silently truncating if it can't reach the cursor within the page cap (fail-loud,
// so a missed leader event surfaces instead of hiding). These tests exercise that with a fake Connection.

const PK = { toBase58: () => 'LEADER' } as unknown as PublicKey;

/** Build deps with a fake Connection that serves `getSignaturesForAddress` from a scripted page function. */
function depsWithSignatures(
  pageFn: (opts: {
    limit?: number;
    until?: string;
    before?: string;
  }) => Array<{ signature: string; err: unknown }>,
) {
  const getSignaturesForAddress = vi.fn(
    async (_pk: PublicKey, opts: { limit?: number; until?: string; before?: string }) =>
      pageFn(opts),
  );
  const conn = { getSignaturesForAddress } as unknown as Connection;
  const deps = makeDetectionDeps({
    conn,
    pk: PK,
    poolReader: {} as never,
    tokenMeta: {} as never,
    onEvent: () => undefined,
  });
  return { deps, getSignaturesForAddress };
}

describe('makeDetectionDeps.listSignaturesSince — no-miss signature ingestion', () => {
  it('cold start (no cursor) → a BOUNDED recent page, failed txs dropped (no full-wallet replay)', async () => {
    const { deps, getSignaturesForAddress } = depsWithSignatures((opts) => {
      expect(opts.until).toBeUndefined(); // cold start passes a limit, not a cursor
      expect(opts.limit).toBeGreaterThan(0); // bounded
      return [
        { signature: 'a', err: null },
        { signature: 'bad', err: { InstructionError: [] } }, // a failed tx must NOT be ingested
        { signature: 'b', err: null },
      ];
    });
    const out = await deps.listSignaturesSince(undefined);
    expect(out.map((s) => s.signature)).toEqual(['a', 'b']);
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1); // cold start = a single bounded page
  });

  it('poll → COMPLETE multi-page sweep newer than the cursor, advancing `before` until a short page', async () => {
    // Page 1 = a full 1000-sig page (forces a second fetch); page 2 = short → done. Proves it does not stop at the
    // first page (a single-page poll would MISS everything older in the same poll window).
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ signature: `p1-${i}`, err: null }));
    const calls: Array<{ until?: string; before?: string }> = [];
    const { deps, getSignaturesForAddress } = depsWithSignatures((opts) => {
      calls.push({ until: opts.until, before: opts.before });
      if (opts.before === undefined) return fullPage; // first page
      return [{ signature: 'p2-0', err: null }]; // second page (short) → loop ends
    });
    const out = await deps.listSignaturesSince('CURSOR');
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(2); // paginated past the first full page
    expect(calls[0]?.until).toBe('CURSOR'); // every page is bounded BELOW by the cursor (contiguous, no gap)
    expect(calls[1]?.until).toBe('CURSOR');
    expect(calls[1]?.before).toBe('p1-999'); // advanced by the last sig of page 1
    expect(out).toHaveLength(1001);
    expect(out.at(-1)?.signature).toBe('p2-0');
  });

  it('poll → drops failed txs across pages (only successful txs are copied)', async () => {
    const { deps } = depsWithSignatures(() => [
      { signature: 'ok1', err: null },
      { signature: 'fail', err: 'BlockhashNotFound' },
      { signature: 'ok2', err: null },
    ]); // single short page
    const out = await deps.listSignaturesSince('CURSOR');
    expect(out.map((s) => s.signature)).toEqual(['ok1', 'ok2']);
  });

  it('poll → THROWS (fail-loud) instead of silently truncating when the cursor is unreachable within the page cap', async () => {
    // Always return a FULL page → the cursor is never reached → the page cap trips. A no-miss guardrail must
    // surface this (retry next poll), never return a partial set that looks complete.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ signature: `s-${i}`, err: null }));
    let n = 0;
    const { deps } = depsWithSignatures(() => {
      n++;
      return fullPage.map((s) => ({ signature: `${s.signature}-${n}`, err: null })); // unique each page → before always advances
    });
    await expect(deps.listSignaturesSince('CURSOR')).rejects.toThrow(/page/i);
  });
});

describe('makeDetectionDeps.classify — null-tx refetch (WS outruns RPC availability)', () => {
  it('refetches ONLY still-null slots and stops early once everything resolves (no wasted refetch)', async () => {
    // First fetch: both null (WS beat the read replica). Refetch: both resolve to non-DLMM txs (no events, but the
    // null-refetch loop must run then stop). We assert the refetch happened and then stopped (≤ initial + 1).
    let call = 0;
    const getParsedTransactions = vi.fn(async (sigs: string[]) => {
      call++;
      return call === 1
        ? sigs.map(() => null)
        : sigs.map(() => ({
            blockTime: 1,
            meta: { innerInstructions: [] },
            transaction: { signatures: ['x'], message: { instructions: [] } },
          }));
    });
    const conn = { getParsedTransactions } as unknown as Connection;
    const deps = makeDetectionDeps({
      conn,
      pk: PK,
      poolReader: {} as never,
      tokenMeta: { resolve: async () => new Map() } as never,
      onEvent: () => undefined,
    });
    const { events, unresolved } = await deps.classify(['s1', 's2']);
    expect(events.size).toBe(0); // non-DLMM txs → no events (we're testing the refetch mechanics, not event building)
    expect(unresolved.size).toBe(0); // both slots resolved on the refetch → nothing left unresolved
    expect(getParsedTransactions).toHaveBeenCalledTimes(2); // 1 initial + 1 refetch (then no nulls → stop)
    expect(getParsedTransactions.mock.calls[1]?.[0]).toEqual(['s1', 's2']); // refetched the previously-null slots
  });

  it('a slot STILL null after every retry is reported UNRESOLVED (never mislabeled as a resolved non-DLMM tx)', async () => {
    // WHY: unresolved ≠ non-DLMM. If a permanently-null tx (RPC not caught up) were dropped as "resolved non-DLMM",
    // the detector would commit the cursor past it and MISS the event forever. It MUST come back in `unresolved`.
    const getParsedTransactions = vi.fn(async (sigs: string[]) => sigs.map(() => null));
    const conn = { getParsedTransactions } as unknown as Connection;
    const deps = makeDetectionDeps({
      conn,
      pk: PK,
      poolReader: {} as never,
      tokenMeta: { resolve: async () => new Map() } as never,
      onEvent: () => undefined,
    });
    const { events, unresolved } = await deps.classify(['s1']);
    expect(events.size).toBe(0);
    expect([...unresolved]).toEqual(['s1']); // the null-forever sig surfaces as unresolved → detector holds the cursor
  });

  it('no refetch when the first fetch already resolves every slot', async () => {
    const getParsedTransactions = vi.fn(async (sigs: string[]) =>
      sigs.map(() => ({
        blockTime: 1,
        meta: { innerInstructions: [] },
        transaction: { signatures: ['x'], message: { instructions: [] } },
      })),
    );
    const conn = { getParsedTransactions } as unknown as Connection;
    const deps = makeDetectionDeps({
      conn,
      pk: PK,
      poolReader: {} as never,
      tokenMeta: { resolve: async () => new Map() } as never,
      onEvent: () => undefined,
    });
    const { unresolved } = await deps.classify(['s1']);
    expect(unresolved.size).toBe(0); // resolved on the first fetch → nothing unresolved
    expect(getParsedTransactions).toHaveBeenCalledTimes(1); // nothing null → no refetch
  });
});

describe('chunk', () => {
  it('splits into order-preserving batches of at most `size`, last batch shorter', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('an exact multiple splits evenly with no empty trailing batch', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
  it('fewer items than `size` → a single batch; empty → no batches', () => {
    expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
    expect(chunk([], 100)).toEqual([]);
  });
});

describe('makeDetectionDeps.classify — getParsedTransactions is batched (bounded RPC calls, #50)', () => {
  it('fans a large signature backlog into calls of at most CLASSIFY_TX_BATCH (100), covering every sig in order', async () => {
    // WHY #50: getParsedTransactions is NOT gated by the per-call RPC limiter, and one oversized batched call over a
    // huge backlog can itself trip a provider 429 that degrades every process sharing the Helius key. A backlog of
    // 250 sigs must fan into 100 + 100 + 50 (never one 250-wide call), and stay index-aligned (no missed tx).
    const NON_DLMM_TX = {
      blockTime: 1,
      meta: { innerInstructions: [] },
      transaction: { signatures: ['x'], message: { instructions: [] } },
    };
    const batchSizes: number[] = [];
    const seen: string[] = [];
    const getParsedTransactions = vi.fn(async (sigs: string[]) => {
      batchSizes.push(sigs.length);
      seen.push(...sigs);
      return sigs.map(() => NON_DLMM_TX); // all resolve → no null-refetch, isolates the initial batched fetch
    });
    const conn = { getParsedTransactions } as unknown as Connection;
    const deps = makeDetectionDeps({
      conn,
      pk: PK,
      poolReader: {} as never,
      tokenMeta: { resolve: async () => new Map() } as never,
      onEvent: () => undefined,
    });
    const signatures = Array.from({ length: 250 }, (_, i) => `s${i}`);
    const { unresolved } = await deps.classify(signatures);
    expect(unresolved.size).toBe(0);
    expect(batchSizes).toEqual([100, 100, 50]); // bounded — never a single oversized call
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(100);
    expect(seen).toEqual(signatures); // every sig fetched exactly once, in order (index alignment preserved)
  });
});

// --- WS fast-path (#32): the WS delivers the full tx; classify must decode from THOSE bytes and skip the RPC
// re-fetch. Real Event-CPI byte layout ([8 self-CPI tag][8 disc][borsh]), same technique as classify-dlmm-tx.test. ---
const b58 = utils.bytes.bs58;
const PKB = (b: number): Buffer => Buffer.alloc(32, b);
const cpi = (disc: number[], body: Buffer): string =>
  b58.encode(Buffer.concat([Buffer.alloc(8), Buffer.from(disc), body]));
const amountsBuf = (x: bigint, y: bigint): Buffer => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(x, 0);
  b.writeBigUInt64LE(y, 8);
  return b;
};
const binBuf = (bin: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(bin, 0);
  return b;
};
const removeLiquidity = (x: bigint, y: bigint, bin: number): string =>
  cpi(
    [116, 244, 97, 232, 103, 31, 152, 58],
    Buffer.concat([PKB(1), PKB(2), PKB(3), amountsBuf(x, y), binBuf(bin)]),
  );
const closePosition = (): string =>
  cpi([255, 196, 16, 107, 28, 202, 53, 128], Buffer.concat([PKB(3), PKB(9)]));
const POSITION = b58.encode(PKB(3));
const SOL = 'So11111111111111111111111111111111111111112';
const NONSOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// SOL on side Y + bin 0 (price = 1) → legValueSol equals exactly amountY/1e9 (deterministic, no bin math).
const SOL_Y = { binStep: 1, solSide: 'Y' as const, mintX: NONSOL, mintY: SOL };

// A full parsed tx as the WS delivers it (real DLMM Event-CPI bytes in innerInstructions — the #117 gate path).
const wsTx = (datas: string[]): ParsedTransactionWithMeta =>
  ({
    blockTime: null, // the notification carries no blockTime → null (poll re-covers the audit timestamp)
    transaction: { signatures: ['sigWs'] },
    meta: {
      logMessages: [`Program ${DLMM_PROGRAM_ID} invoke [1]`],
      innerInstructions: [
        { index: 0, instructions: datas.map((d) => ({ programId: DLMM_PROGRAM_ID, data: d })) },
      ],
    },
  }) as unknown as ParsedTransactionWithMeta;

describe('makeDetectionDeps.classify — WS fast-path (delivered tx skips the RPC re-fetch, #32)', () => {
  function fastPathDeps() {
    // Any fetch returns a non-DLMM tx — so a call is unambiguous proof of a FETCH, isolating the prefetch path.
    const getParsedTransactions = vi.fn(async (sigs: string[]) =>
      sigs.map(() => ({
        blockTime: 1,
        meta: { innerInstructions: [] },
        transaction: { signatures: ['x'], message: { instructions: [] } },
      })),
    );
    const conn = { getParsedTransactions } as unknown as Connection;
    const loadPoolMeta = vi.fn(async () => SOL_Y);
    const deps = makeDetectionDeps({
      conn,
      pk: PK,
      poolReader: { loadPoolMeta } as never,
      tokenMeta: { resolve: async () => new Map() } as never,
      onEvent: () => undefined,
    });
    return { deps, getParsedTransactions };
  }

  it('a complete WS-delivered close classifies from the payload — getParsedTransactions is NEVER called', async () => {
    // THE FIX (#32): the WS already carries the full tx (incl. innerInstructions). classify must decode THAT and
    // never re-fetch — a re-fetch can hit a lagging read replica and burn up to ~1s of null-retry sleeps for a tx
    // we already hold. Assert zero RPC fetches AND that the close is detected from the delivered bytes.
    const { deps, getParsedTransactions } = fastPathDeps();
    const closeTx = wsTx([removeLiquidity(0n, 2_000_000_000n, 0), closePosition()]);
    const { events, unresolved } = await deps.classify(['sigWs'], new Map([['sigWs', closeTx]]));
    expect(getParsedTransactions).not.toHaveBeenCalled(); // NO re-fetch — the whole point of the fix
    expect(unresolved.size).toBe(0);
    const ev = events.get('sigWs')?.[0];
    expect(ev?.closed).toBe(true); // the close IS detected straight from the WS payload
    expect(ev?.withdrawSol).toBeCloseTo(2, 9);
    expect(ev?.position).toBe(POSITION);
  });

  it('mixed batch: ONLY the sigs without a delivered tx are fetched (per-sig fallback, never-miss)', async () => {
    // The prefetched sig skips the fetch; a sig with no delivered payload still falls back to RPC — so the fast
    // path can never SUPPRESS a fetch a non-delivered sig needs (no silent miss), yet still saves the delivered one.
    const { deps, getParsedTransactions } = fastPathDeps();
    const closeTx = wsTx([removeLiquidity(0n, 1_000_000_000n, 0), closePosition()]);
    const { events } = await deps.classify(['sigWs', 'sigMiss'], new Map([['sigWs', closeTx]]));
    expect(getParsedTransactions).toHaveBeenCalledTimes(1);
    expect(getParsedTransactions.mock.calls[0]?.[0]).toEqual(['sigMiss']); // ONLY the un-delivered sig is fetched
    expect(events.get('sigWs')?.[0]?.closed).toBe(true); // prefetched close still detected
    expect(events.has('sigMiss')).toBe(false); // the fetched non-DLMM sig produced no event
  });
});
