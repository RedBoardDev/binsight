import { TOKEN_PROGRAM_ID } from '@binsight/shared';
import { type Connection, type ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestCursor, SwapFlowRow, WalletFlowRow } from '@/domain/dlmm';
import type { LegRepository, SwapFlowRepository, WalletFlowRepository } from '@/domain/ports';
import { WalletTxIngest } from './wallet-tx-ingest';

// A syntactically valid pubkey standing in for a wallet — never a real address.
const WALLET = PublicKey.default.toBase58();
const MINT = 'So11111111111111111111111111111111111111113'; // valid base58, not SOL
const logger = pino({ level: 'silent' });

type SigEntry = { signature: string; err: unknown; blockTime: number | null };
const sig = (signature: string, err: unknown = null): SigEntry => ({
  signature,
  err,
  blockTime: 1_700_000_000,
});

/** An external SOL transfer out of the wallet: yields one flow row, no legs, no swaps. */
const transferTx = (signature: string): ParsedTransactionWithMeta =>
  ({
    blockTime: 1_700_000_000,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [{ pubkey: WALLET }, { pubkey: 'CEX' }],
        instructions: [
          {
            program: 'system',
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: { source: WALLET, destination: 'CEX', lamports: 1e9 },
            },
          },
        ],
      },
    },
    meta: {
      fee: 5000,
      err: null,
      preBalances: [10e9, 0],
      postBalances: [9e9, 0],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
  }) as unknown as ParsedTransactionWithMeta;

/** A clean token→SOL sale: yields one flow row AND one swap row from the SAME fetch. */
const swapTx = (signature: string): ParsedTransactionWithMeta =>
  ({
    blockTime: 1_700_000_100,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [{ pubkey: WALLET }, { pubkey: 'TOK_ATA' }, { pubkey: 'POOL' }],
        instructions: [
          {
            program: 'spl-token',
            programId: TOKEN_PROGRAM_ID,
            parsed: {
              type: 'transferChecked',
              info: {
                source: 'TOK_ATA',
                destination: 'POOL',
                mint: MINT,
                tokenAmount: { amount: '100000000', decimals: 6, uiAmount: 100 },
                authority: WALLET,
              },
            },
          },
          {
            program: 'system',
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: { source: 'POOL', destination: WALLET, lamports: 2e9 },
            },
          },
        ],
      },
    },
    meta: {
      fee: 5000,
      err: null,
      preBalances: [10e9, 0, 0],
      postBalances: [12e9, 0, 0],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: MINT,
          owner: WALLET,
          uiTokenAmount: { amount: '100000000', decimals: 6, uiAmount: 100, uiAmountString: '100' },
        },
      ],
      postTokenBalances: [],
      innerInstructions: [],
    },
  }) as unknown as ParsedTransactionWithMeta;

function harness(opts: {
  pages: SigEntry[][];
  txs?: Record<string, ParsedTransactionWithMeta>;
  cursor?: IngestCursor | null;
  txError?: () => boolean;
}) {
  const getSignaturesForAddress = vi.fn(async () => opts.pages.shift() ?? []);
  const getParsedTransaction = vi.fn(async (s: string) => {
    if (opts.txError?.()) throw new Error('rpc down');
    return opts.txs?.[s] ?? null;
  });
  const conn = { getSignaturesForAddress, getParsedTransaction } as unknown as Connection;

  const legCursor: { value: IngestCursor | null } = { value: opts.cursor ?? null };
  const written = {
    legs: [] as { sigs: string[]; count: number }[],
    flows: [] as WalletFlowRow[],
    swaps: [] as SwapFlowRow[],
    cursors: [] as { repo: string; cursor: IngestCursor }[],
  };

  const legs = {
    getCursor: async () => legCursor.value,
    setCursor: async (_w: string, c: IngestCursor) => {
      written.cursors.push({ repo: 'legs', cursor: c });
    },
    replaceForSignatures: async (_w: string, sigs: string[], rows: unknown[]) => {
      written.legs.push({ sigs, count: rows.length });
    },
  } as unknown as LegRepository;
  const flows = {
    upsertFlows: async (_w: string, rows: WalletFlowRow[]) => {
      written.flows.push(...rows);
    },
    setCursor: async (_w: string, c: IngestCursor) => {
      written.cursors.push({ repo: 'flows', cursor: c });
    },
  } as unknown as WalletFlowRepository;
  const swaps = {
    upsertMany: async (rows: SwapFlowRow[]) => {
      written.swaps.push(...rows);
    },
    setCursor: async (_w: string, c: IngestCursor) => {
      written.cursors.push({ repo: 'swaps', cursor: c });
    },
  } as unknown as SwapFlowRepository;

  return {
    // Instant backoff: these tests assert retry SEMANTICS, not wall-clock patience.
    ingest: new WalletTxIngest(conn, legs, flows, swaps, logger, async () => {}),
    getSignaturesForAddress,
    getParsedTransaction,
    written,
  };
}

describe('WalletTxIngest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('costs ONE signature page and zero transaction fetches when nothing is new', async () => {
    // WHY this is the whole point: the Enhanced API billed a full page (100 credits) per trigger just to
    // discover there was nothing to do. Here an idle poll is a single 1-credit call.
    const h = harness({
      cursor: { newestSig: 'TOP', oldestSig: 'BOTTOM', complete: true },
      pages: [[sig('TOP')]],
    });
    const res = await h.ingest.ingest(WALLET);

    expect(h.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(h.getParsedTransaction).not.toHaveBeenCalled();
    expect(res).toMatchObject({ txs: 0, legs: 0, flows: 0, swaps: 0, complete: true });
  });

  it('fetches each transaction ONCE and fans it out to legs, flows and swaps', async () => {
    const h = harness({
      cursor: { newestSig: 'TOP', oldestSig: 'BOTTOM', complete: true },
      pages: [[sig('SWAP1'), sig('XFER1'), sig('TOP')]],
      txs: { SWAP1: swapTx('SWAP1'), XFER1: transferTx('XFER1') },
    });
    const res = await h.ingest.ingest(WALLET);

    expect(h.getParsedTransaction).toHaveBeenCalledTimes(2); // one call per NEW signature, no more
    expect(res.txs).toBe(2);
    expect(res.flows).toBe(2); // both txs produce a cash-flow row
    expect(res.swaps).toBe(1); // only the swap produces a swap leg
    expect(h.written.swaps[0]).toMatchObject({ mint: MINT, side: 'sell', tokenAmount: 100 });
    expect(h.written.swaps[0]?.solAmount).toBeCloseTo(2, 9);
    expect(h.written.flows.map((f) => f.signature).sort()).toEqual(['SWAP1', 'XFER1']);
  });

  it('never fetches a failed transaction', async () => {
    const h = harness({
      cursor: { newestSig: 'TOP', oldestSig: 'BOTTOM', complete: true },
      pages: [[sig('BAD', { InstructionError: [0, 'Custom'] }), sig('TOP')]],
    });
    await h.ingest.ingest(WALLET);
    expect(h.getParsedTransaction).not.toHaveBeenCalled();
  });

  it('advances all three cursors to the SAME position', async () => {
    // They stay separate tables because each gates something different downstream, but one pagination
    // writes them all — so they cannot drift into disagreeing about what has been read.
    const h = harness({
      cursor: { newestSig: 'TOP', oldestSig: 'BOTTOM', complete: true },
      pages: [[sig('NEW1'), sig('TOP')]],
      txs: { NEW1: transferTx('NEW1') },
    });
    await h.ingest.ingest(WALLET);

    expect(h.written.cursors.map((c) => c.repo).sort()).toEqual(['flows', 'legs', 'swaps']);
    const values = h.written.cursors.map((c) => JSON.stringify(c.cursor));
    expect(new Set(values).size).toBe(1);
    expect(h.written.cursors[0]?.cursor).toMatchObject({ newestSig: 'NEW1', complete: true });
  });

  it('aborts the page WITHOUT writing or advancing when a transaction cannot be fetched', async () => {
    // A failed fetch must never reach replaceForSignatures: that would delete real legs and replace them
    // with an empty set, and advancing the cursor past them would make the loss permanent.
    const h = harness({
      cursor: { newestSig: 'TOP', oldestSig: 'BOTTOM', complete: true },
      pages: [[sig('NEW1'), sig('TOP')]],
      txError: () => true,
    });
    await h.ingest.ingest(WALLET);

    expect(h.written.legs).toEqual([]);
    expect(h.written.flows).toEqual([]);
    // The cursor is rewritten, but to its PREVIOUS top — never past the un-ingested transaction.
    expect(h.written.cursors.every((c) => c.cursor.newestSig === 'TOP')).toBe(true);
  });

  it('keeps the OLD top when a later top-up page fails before reaching it (#35)', async () => {
    // WHY: page 1 fetches and persists fine but does NOT contain the known top, so the gap to it spans
    // page 2 — whose fetch then fails. Storing page 1's top would make every later top-up stop above
    // page 2 and never request it: its legs (a withdraw, a close) would be lost for good, silently.
    // Main fixed exactly this as #35 in the per-source ingest this class replaced.
    const fullPage = Array.from({ length: 1000 }, (_, i) => sig(`N${i}`));
    const txs = Object.fromEntries(fullPage.map((s) => [s.signature, transferTx(s.signature)]));
    let fetches = 0;
    const h = harness({
      cursor: { newestSig: 'TOP', oldestSig: 'BOTTOM', complete: true },
      pages: [fullPage, [sig('GAP'), sig('TOP')]],
      txs,
      txError: () => ++fetches > 1000, // page 1 succeeds; the first fetch of page 2 fails for good
    });
    await h.ingest.ingest(WALLET);

    expect(h.written.legs).toHaveLength(1); // page 1 WAS persisted — progress is not thrown away…
    for (const { cursor } of h.written.cursors) {
      expect(cursor.newestSig).toBe('TOP'); // …but the stored top does not jump past the gap
      expect(cursor.oldestSig).toBe('BOTTOM');
    }
  });

  it('never clobbers the genesis oldestSig on a successful top-up', async () => {
    // A top-up stops above genesis; the page's last signature is NOT the wallet's oldest.
    const h = harness({
      cursor: { newestSig: 'TOP', oldestSig: 'BOTTOM', complete: true },
      pages: [[sig('NEW1'), sig('TOP')]],
      txs: { NEW1: transferTx('NEW1') },
    });
    await h.ingest.ingest(WALLET);
    expect(h.written.cursors[0]?.cursor).toMatchObject({
      newestSig: 'NEW1',
      oldestSig: 'BOTTOM',
      complete: true,
    });
  });

  it('marks the backfill complete when a short page proves genesis was reached', async () => {
    const h = harness({
      cursor: null,
      pages: [[sig('ONLY')]],
      txs: { ONLY: transferTx('ONLY') },
    });
    const res = await h.ingest.ingest(WALLET);
    expect(res.complete).toBe(true);
    expect(h.written.cursors[0]?.cursor).toMatchObject({ newestSig: 'ONLY', oldestSig: 'ONLY' });
  });

  it('keeps complete=false when a page fails mid-backfill, so a re-run resumes', async () => {
    const h = harness({ cursor: null, pages: [[sig('A')]], txError: () => true });
    const res = await h.ingest.ingest(WALLET);
    expect(res.complete).toBe(false);
  });
});
