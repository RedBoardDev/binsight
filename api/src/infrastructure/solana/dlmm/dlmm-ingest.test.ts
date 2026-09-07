import type { Connection } from '@solana/web3.js';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LegRepository } from '@/domain/ports';
import { DlmmIngest } from './dlmm-ingest';

const WALLET = 'So11111111111111111111111111111111111111112';
const logger = pino({ level: 'silent' });

/** A minimal parsed tx (no DLMM legs) — the decoder yields [], so the test isolates the FETCH fallback. */
const fakeTx = (sig: string) =>
  ({
    slot: 1,
    blockTime: 100,
    transaction: { signatures: [sig], message: { accountKeys: [], instructions: [] } },
    meta: { err: null, innerInstructions: [], preBalances: [], postBalances: [] },
  }) as unknown as Record<string, unknown>;

class FakeRepo implements Partial<LegRepository> {
  replaced: { sigs: string[]; legs: unknown[] }[] = [];
  async getCursor() {
    return null;
  }
  async replaceForSignatures(_w: string, sigs: string[], legs: unknown[]) {
    this.replaced.push({ sigs, legs });
  }
  async setCursor() {}
}

describe('DlmmIngest — free-tier single-call fallback', () => {
  it('falls back to single getParsedTransaction when the RPC rejects BATCH requests (free tier)', async () => {
    // WHY: free Helius keys 403 batch JSON-RPC ("Batch requests are only available for paid plans").
    // getParsedTransactions sends a batch, so without a fallback the leg ingest ABORTS the page = missed
    // legs (no-miss broken) on a free key. The fallback must fetch each sig with a SINGLE call and ingest
    // the page normally.
    let batchCalls = 0;
    let singleCalls = 0;
    const conn = {
      async getSignaturesForAddress(_owner: unknown, opts: { before?: string }) {
        // one page (2 sigs) then nothing; <1000 rows ends the backfill at genesis.
        return opts?.before
          ? []
          : [
              { signature: 'sigA', err: null, blockTime: 100 },
              { signature: 'sigB', err: null, blockTime: 99 },
            ];
      },
      async getParsedTransactions() {
        batchCalls++;
        throw new Error(
          '403 Forbidden: {"jsonrpc":"2.0","error":{"code":-32403,"message":"Batch requests are only available for paid plans. Please upgrade"}}',
        );
      },
      async getParsedTransaction(sig: string) {
        singleCalls++;
        return fakeTx(sig);
      },
    } as unknown as Connection;

    const repo = new FakeRepo();
    const ingest = new DlmmIngest(conn, repo as unknown as LegRepository, logger);
    const res = await ingest.ingest(WALLET);

    expect(batchCalls).toBeGreaterThanOrEqual(1); // it TRIED the batch…
    expect(singleCalls).toBe(2); // …then fell back to ONE single call per sig
    expect(res.txs).toBe(2); // both txs decoded (page not aborted)
    // the page was persisted (replaceForSignatures), NOT dropped — no missed legs on a free key.
    expect(repo.replaced).toHaveLength(1);
    expect(repo.replaced[0]!.sigs).toEqual(['sigA', 'sigB']);
    expect(res.complete).toBe(true);
  });

  it('a FAILED page fetch does NOT advance the cursor past un-ingested txs (no silent no-miss gap)', async () => {
    // WHY (regression): the top-up set newestSig from the page BEFORE fetching. A failed fetch (a free-tier
    // batch-403 abort, a network blip) then aborted the page but the cursor had ALREADY moved to the new
    // top → those txs were never re-fetched. A leader's RemoveLiquidity withdraw was silently dropped (wrong
    // PnL). The cursor must only advance to a SUCCESSFULLY-ingested page; a failure keeps the old top so the
    // next run re-fetches.
    vi.useFakeTimers();
    const conn = {
      async getSignaturesForAddress(_o: unknown, opts: { before?: string }) {
        // top-up: two NEW sigs above the known top, then the known top ends the scan.
        return opts?.before
          ? []
          : [
              { signature: 'newSig', err: null, blockTime: 200 },
              { signature: 'oldTop', err: null, blockTime: 100 },
            ];
      },
      async getParsedTransactions() {
        throw new Error('network down'); // hard failure (NOT batch-unsupported) → retries then aborts
      },
      async getParsedTransaction() {
        throw new Error('network down');
      },
    } as unknown as Connection;
    const setCursors: { newestSig: string | null }[] = [];
    const repo = {
      async getCursor() {
        return { newestSig: 'oldTop', oldestSig: 'oldBottom', complete: true };
      },
      async replaceForSignatures() {},
      async setCursor(_w: string, c: { newestSig: string | null }) {
        setCursors.push(c);
      },
    } as unknown as LegRepository;

    const ingest = new DlmmIngest(conn, repo, logger);
    const p = ingest.ingest(WALLET);
    await vi.runAllTimersAsync(); // flush the retry back-off sleeps
    await p;
    vi.useRealTimers();

    // the cursor stayed at the OLD top — the un-ingested 'newSig' will be re-fetched next run (no gap).
    expect(setCursors.at(-1)?.newestSig).toBe('oldTop');
  });
});

describe('DlmmIngest — top-up cursor advance is gated on reaching the known top (no silent gap)', () => {
  const SIG_PAGE = 1000; // must mirror the module constant so page 1 is a FULL page → paging continues

  it('a top-up whose LATER page fails keeps the OLD top + genesis oldest (re-pages the gap next run)', async () => {
    // WHY (regression #35): the first page succeeded (advancing the run's top), then a later page's decode
    // failed BEFORE reconnecting to the known top — leaving a gap of un-ingested DLMM legs. If the stored
    // top advanced to the new top anyway, every subsequent top-up would start from the NEW top and NEVER
    // re-request that gap → the leader's opens/adds/removes/closes/claims in it are dropped forever.
    vi.useFakeTimers();
    // A FULL first page (1000 new sigs above the old top) so the loop pages on to a second page.
    const page1 = Array.from({ length: SIG_PAGE }, (_, i) => ({
      signature: `p1-${i}`,
      err: null,
      blockTime: 1_000_000 - i,
    }));
    // The second page does NOT contain the old top (the reconnect is deeper, never reached) and its decode
    // fails — so `hitKnownTop` stays false and the guard must keep the old top.
    const page2 = [
      { signature: 'p2-0', err: null, blockTime: 500_000 },
      { signature: 'p2-1', err: null, blockTime: 499_999 },
    ];
    const conn = {
      async getSignaturesForAddress(_o: unknown, opts: { before?: string }) {
        if (!opts?.before) return page1;
        if (opts.before === `p1-${SIG_PAGE - 1}`) return page2;
        return [];
      },
      async getParsedTransactions(sigs: string[]) {
        if (sigs.some((s) => s.startsWith('p2-'))) throw new Error('network down');
        return sigs.map((s) => fakeTx(s));
      },
      async getParsedTransaction(sig: string) {
        if (sig.startsWith('p2-')) throw new Error('network down');
        return fakeTx(sig);
      },
    } as unknown as Connection;
    const setCursors: { newestSig: string | null; oldestSig: string | null }[] = [];
    const repo = {
      async getCursor() {
        return { newestSig: 'oldTop', oldestSig: 'oldBottom', complete: true };
      },
      async replaceForSignatures() {},
      async setCursor(_w: string, c: { newestSig: string | null; oldestSig: string | null }) {
        setCursors.push(c);
      },
    } as unknown as LegRepository;

    const ingest = new DlmmIngest(conn, repo, logger);
    const p = ingest.ingest(WALLET);
    await vi.runAllTimersAsync(); // flush the batch-pause + retry back-off sleeps
    await p;
    vi.useRealTimers();

    // gap left behind → keep the old top so the next top-up re-pages and closes it…
    expect(setCursors.at(-1)?.newestSig).toBe('oldTop');
    // …and a top-up must NOT clobber the true genesis oldest recorded at backfill.
    expect(setCursors.at(-1)?.oldestSig).toBe('oldBottom');
  });

  it('a top-up that REACHES the known top advances the stored top (and preserves genesis oldest)', async () => {
    // The counterpart: when the run reconnects to the old top, the new sigs above it are ingested and the
    // stored top may safely advance to the true new top — the normal incremental top-up.
    vi.useFakeTimers();
    const conn = {
      async getSignaturesForAddress(_o: unknown, opts: { before?: string }) {
        // one page: a new sig above the old top, then the old top reconnects the scan.
        return opts?.before
          ? []
          : [
              { signature: 'newTop', err: null, blockTime: 200 },
              { signature: 'oldTop', err: null, blockTime: 100 },
            ];
      },
      async getParsedTransactions(sigs: string[]) {
        return sigs.map((s) => fakeTx(s));
      },
      async getParsedTransaction(sig: string) {
        return fakeTx(sig);
      },
    } as unknown as Connection;
    const setCursors: { newestSig: string | null; oldestSig: string | null }[] = [];
    const repo = {
      async getCursor() {
        return { newestSig: 'oldTop', oldestSig: 'oldBottom', complete: true };
      },
      async replaceForSignatures() {},
      async setCursor(_w: string, c: { newestSig: string | null; oldestSig: string | null }) {
        setCursors.push(c);
      },
    } as unknown as LegRepository;

    const ingest = new DlmmIngest(conn, repo, logger);
    const p = ingest.ingest(WALLET);
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();

    // reconnected → advance to the true new top; the genesis oldest is untouched by a top-up.
    expect(setCursors.at(-1)?.newestSig).toBe('newTop');
    expect(setCursors.at(-1)?.oldestSig).toBe('oldBottom');
  });
});
