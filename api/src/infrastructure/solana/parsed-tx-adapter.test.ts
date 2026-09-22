import { createHash } from 'node:crypto';
import { DLMM_PROGRAM_ID, SOL_MINT, TOKEN_PROGRAM_ID } from '@binsight/shared';
import { utils } from '@coral-xyz/anchor';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

const bs58encode = (b: Uint8Array): string => utils.bytes.bs58.encode(b);

import { type EnhancedTx, parseSwapBuy, parseSwapSell, walletSolFlow } from './helius-enhanced';
import { extractFlowRow, extractSwapRows, parsedTxToEnhancedTx } from './parsed-tx-adapter';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fixture builders — synthesize a `getParsedTransaction` (jsonParsed) result the SAME way the existing
// dlmm-event-decoder.test.ts does (plain strings for pubkeys, cast `as unknown`), so these tests
// exercise the real reconstruction path with zero network. Account keys are plain strings; their
// .toString() is identity, matching how the adapter reads `accountKeys[i].pubkey.toString()`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const WALLET = 'WALLET';
const MINT_X = 'MINTX';
const MINT_Y = 'MINTY';
const USDC = 'USDC';
const TOK_DEC = 6;
const WSOL_DEC = 9;
const SIG = 'SIG_MAIN';
const TS = 1_700_000_000;

type AnyIx = Record<string, unknown>;

const splTransfer = (
  source: string,
  destination: string,
  amount: string,
  authority?: string,
): AnyIx => ({
  program: 'spl-token',
  programId: TOKEN_PROGRAM_ID,
  parsed: {
    type: 'transfer',
    info: { source, destination, amount, ...(authority ? { authority } : {}) },
  },
});

const splTransferChecked = (
  source: string,
  destination: string,
  mint: string,
  uiAmount: number,
  amount: string,
  decimals: number,
  authority?: string,
): AnyIx => ({
  program: 'spl-token',
  programId: TOKEN_PROGRAM_ID,
  parsed: {
    type: 'transferChecked',
    info: {
      source,
      destination,
      mint,
      tokenAmount: { amount, decimals, uiAmount },
      ...(authority ? { authority } : {}),
    },
  },
});

const sysTransfer = (source: string, destination: string, lamports: number): AnyIx => ({
  program: 'system',
  programId: SYSTEM_PROGRAM_ID,
  parsed: { type: 'transfer', info: { source, destination, lamports } },
});

/** A partially-decoded (unparsed) instruction — only programId is known (e.g. a DLMM/DEX call). */
const opaqueIx = (programId: string): AnyIx => ({ programId, accounts: [], data: '' });

interface Tb {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number; uiAmountString: string };
}
const tb = (
  accountIndex: number,
  mint: string,
  owner: string,
  amount: string,
  decimals: number,
): Tb => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: {
    amount,
    decimals,
    uiAmount: Number(amount) / 10 ** decimals,
    uiAmountString: String(Number(amount) / 10 ** decimals),
  },
});

interface PtxOpts {
  signature?: string;
  blockTime?: number | null;
  accountKeys?: string[];
  topInstructions?: AnyIx[];
  innerInstructions?: { index: number; instructions: AnyIx[] }[];
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: Tb[];
  postTokenBalances?: Tb[];
  /** when true, meta is explicitly null (degenerate / not-found tx). */
  nullMeta?: boolean;
  /** non-null marks the tx as FAILED — its instructions ran but changed no state beyond the fee. */
  err?: unknown;
}
const ptx = (o: PtxOpts): ParsedTransactionWithMeta =>
  ({
    blockTime: o.blockTime === undefined ? TS : o.blockTime,
    transaction: {
      signatures: [o.signature ?? SIG],
      message: {
        accountKeys: (o.accountKeys ?? []).map((pubkey) => ({ pubkey })),
        instructions: o.topInstructions ?? [],
      },
    },
    meta: o.nullMeta
      ? null
      : {
          fee: 5000,
          err: o.err ?? null,
          preBalances: o.preBalances ?? [],
          postBalances: o.postBalances ?? [],
          preTokenBalances: o.preTokenBalances ?? [],
          postTokenBalances: o.postTokenBalances ?? [],
          innerInstructions: o.innerInstructions ?? [],
        },
  }) as unknown as ParsedTransactionWithMeta;

/** A DLMM instruction carrying a REAL Anchor discriminator, base58-encoded exactly as the RPC returns
 *  it — so the position/swap split is exercised through the same decoding path production uses. */
const dlmmIx = (instructionName: string): AnyIx => ({
  programId: DLMM_PROGRAM_ID,
  accounts: [],
  data: bs58encode(
    createHash('sha256').update(`global:${instructionName}`).digest().subarray(0, 8),
  ),
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1) Adapter reconstruction — assert parsedTxToEnhancedTx rebuilds exactly what Helius enriches.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('parsedTxToEnhancedTx — field reconstruction', () => {
  it('rebuilds a transferChecked into a tokenTransfer using the ix mint + uiAmount, owners resolved', () => {
    // WHY: transferChecked carries mint+decimals+uiAmount in the ix; from/to must be the OWNER wallets
    // (not the ATAs), so the swap parsers see the wallet on the right side of the flow.
    const enhanced = parsedTxToEnhancedTx(
      ptx({
        accountKeys: [WALLET, 'WX_ATA', 'POOL_X_ATA', 'POOL'],
        topInstructions: [
          splTransferChecked('WX_ATA', 'POOL_X_ATA', MINT_X, 100, '100000000', TOK_DEC, WALLET),
        ],
        preTokenBalances: [tb(1, MINT_X, WALLET, '100000000', TOK_DEC)],
        postTokenBalances: [tb(2, MINT_X, 'POOL', '100000000', TOK_DEC)],
      }),
    );
    expect(enhanced.tokenTransfers).toEqual([
      { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'POOL', tokenAmount: 100 },
    ]);
    expect(enhanced.signature).toBe(SIG);
    expect(enhanced.timestamp).toBe(TS);
  });

  it('rebuilds a BARE transfer by resolving mint+decimals from token balances, raw→decimal amount', () => {
    // WHY: a bare `transfer` ix omits mint AND decimals; the only place to recover them is the source
    // token account's pre/post balance entry. A wrong decimals here would corrupt every downstream sum.
    const enhanced = parsedTxToEnhancedTx(
      ptx({
        accountKeys: [WALLET, 'WX_ATA', 'DEST_ATA'],
        topInstructions: [splTransfer('WX_ATA', 'DEST_ATA', '2500000', WALLET)], // raw 2_500_000
        preTokenBalances: [tb(1, MINT_X, WALLET, '2500000', TOK_DEC)],
        postTokenBalances: [tb(2, MINT_X, 'OTHER', '2500000', TOK_DEC)],
      }),
    );
    expect(enhanced.tokenTransfers).toEqual([
      { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'OTHER', tokenAmount: 2.5 }, // 2_500_000 / 1e6
    ]);
  });

  it('falls back to the instruction authority as the source owner when the source ATA has no balance', () => {
    // WHY: if a source token account never appears in pre/postTokenBalances we cannot map it to an owner;
    // the signing `authority` is the documented fallback so the flow is still attributed to the wallet.
    const enhanced = parsedTxToEnhancedTx(
      ptx({
        accountKeys: [WALLET, 'GHOST_SRC', 'DEST_ATA'],
        topInstructions: [
          splTransferChecked('GHOST_SRC', 'DEST_ATA', MINT_X, 7, '7000000', TOK_DEC, WALLET),
        ],
        // only the destination is in balances → source owner is unknown → fall back to authority (WALLET)
        postTokenBalances: [tb(2, MINT_X, 'DEST_OWNER', '7000000', TOK_DEC)],
      }),
    );
    expect(enhanced.tokenTransfers).toEqual([
      { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'DEST_OWNER', tokenAmount: 7 },
    ]);
  });

  it('extracts token transfers nested in INNER instructions (Jupiter-style CPI route)', () => {
    // WHY: in real swaps the token movements live in inner CPIs; missing them would mean missing the swap.
    const enhanced = parsedTxToEnhancedTx(
      ptx({
        accountKeys: [WALLET, 'WX_ATA', 'POOL_X_ATA', 'ROUTER'],
        topInstructions: [opaqueIx('ROUTER_PROGRAM')],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              splTransferChecked('WX_ATA', 'POOL_X_ATA', MINT_X, 42, '42000000', TOK_DEC, WALLET),
            ],
          },
        ],
        preTokenBalances: [tb(1, MINT_X, WALLET, '42000000', TOK_DEC)],
        postTokenBalances: [tb(2, MINT_X, 'POOL', '42000000', TOK_DEC)],
      }),
    );
    expect(enhanced.tokenTransfers).toEqual([
      { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'POOL', tokenAmount: 42 },
    ]);
  });

  it('extracts System-Program SOL transfers (top-level + inner) as nativeTransfers in lamports', () => {
    const enhanced = parsedTxToEnhancedTx(
      ptx({
        accountKeys: [WALLET, 'POOL', 'FEE'],
        topInstructions: [sysTransfer('POOL', WALLET, 2_000_000_000)],
        innerInstructions: [{ index: 0, instructions: [sysTransfer(WALLET, 'FEE', 100_000_000)] }],
      }),
    );
    expect(enhanced.nativeTransfers).toEqual([
      { fromUserAccount: 'POOL', toUserAccount: WALLET, amount: 2_000_000_000 },
      { fromUserAccount: WALLET, toUserAccount: 'FEE', amount: 100_000_000 },
    ]);
  });

  it('reconstructs accountData: nativeBalanceChange = post-pre, token diffs by accountIndex+mint w/ owner', () => {
    // WHY: walletSolFlow reads native change from the wallet's OWN entry and WSOL change from the entry
    // whose tokenBalanceChanges.userAccount === wallet — both must be rebuilt exactly.
    const enhanced = parsedTxToEnhancedTx(
      ptx({
        accountKeys: [WALLET, 'W_WSOL_ATA'],
        preBalances: [10_000_000_000, 2_000_000],
        postBalances: [11_000_000_000, 2_000_000],
        preTokenBalances: [tb(1, SOL_MINT, WALLET, '0', WSOL_DEC)],
        postTokenBalances: [tb(1, SOL_MINT, WALLET, '3000000000', WSOL_DEC)],
      }),
    );
    expect(enhanced.accountData).toEqual([
      { account: WALLET, nativeBalanceChange: 1_000_000_000, tokenBalanceChanges: [] },
      {
        account: 'W_WSOL_ATA',
        nativeBalanceChange: 0,
        tokenBalanceChanges: [
          {
            userAccount: WALLET,
            mint: SOL_MINT,
            rawTokenAmount: { tokenAmount: '3000000000', decimals: WSOL_DEC },
          },
        ],
      },
    ]);
  });

  it('reconstructs instruction programIds (top-level + inner) so the DLMM-touch check sees CPIs', () => {
    const enhanced = parsedTxToEnhancedTx(
      ptx({
        accountKeys: [WALLET],
        topInstructions: [opaqueIx('ROUTER_PROGRAM')],
        innerInstructions: [{ index: 0, instructions: [opaqueIx(DLMM_PROGRAM_ID)] }],
      }),
    );
    expect(enhanced.instructions).toEqual([
      { programId: 'ROUTER_PROGRAM', innerInstructions: [{ programId: DLMM_PROGRAM_ID }] },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2) Parity by construction — for each representative case, feed the SAME logical tx as (a) a synthetic
// ParsedTransactionWithMeta and (b) a hand-built EnhancedTx (what Helius would emit), and prove the
// existing parsers return EXACTLY the same thing on both. This is the guarantee the whole approach rests
// on: we never re-implement swap/flow logic, only reshape the input.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Assert the existing parsers behave identically on the reconstructed tx and the hand-built EnhancedTx. */
function expectParserParity(
  synth: ParsedTransactionWithMeta,
  hand: EnhancedTx,
  wallet: string,
): void {
  const adapter = parsedTxToEnhancedTx(synth);
  expect(parseSwapSell(adapter, wallet)).toEqual(parseSwapSell(hand, wallet));
  expect(parseSwapBuy(adapter, wallet)).toEqual(parseSwapBuy(hand, wallet));
  expect(walletSolFlow(adapter, wallet)).toBeCloseTo(walletSolFlow(hand, wallet), 9);
}

describe('extractSwapRows / extractFlowRow — parity with the Enhanced parsers', () => {
  it('clean SELL with native proceeds → identical sell row + flow', () => {
    const synth = ptx({
      accountKeys: [WALLET, 'WX_ATA', 'POOL_X_ATA', 'POOL'],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            splTransferChecked('WX_ATA', 'POOL_X_ATA', MINT_X, 100, '100000000', TOK_DEC, WALLET),
            sysTransfer('POOL', WALLET, 2_000_000_000),
          ],
        },
      ],
      preBalances: [10_000_000_000, 0, 0, 0],
      postBalances: [12_000_000_000, 0, 0, 0],
      preTokenBalances: [tb(1, MINT_X, WALLET, '100000000', TOK_DEC)],
      postTokenBalances: [tb(2, MINT_X, 'POOL', '100000000', TOK_DEC)],
    });
    const hand: EnhancedTx = {
      signature: SIG,
      timestamp: TS,
      type: 'SWAP',
      tokenTransfers: [
        { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'POOL', tokenAmount: 100 },
      ],
      nativeTransfers: [{ fromUserAccount: 'POOL', toUserAccount: WALLET, amount: 2_000_000_000 }],
      accountData: [
        { account: WALLET, nativeBalanceChange: 2_000_000_000, tokenBalanceChanges: [] },
      ],
      instructions: [],
    };
    expectParserParity(synth, hand, WALLET);
    expect(extractSwapRows(synth, WALLET)).toEqual([
      {
        wallet: WALLET,
        signature: SIG,
        ts: TS,
        mint: MINT_X,
        tokenAmount: 100,
        solAmount: 2,
        side: 'sell',
      },
    ]);
    expect(extractFlowRow(synth, WALLET)?.solFlow).toBeCloseTo(2, 9);
  });

  it('clean BUY with native spent → identical buy row (solAmount = SOL spent)', () => {
    const synth = ptx({
      accountKeys: [WALLET, 'POOL_X_ATA', 'WX_ATA', 'POOL'],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            splTransferChecked('POOL_X_ATA', 'WX_ATA', MINT_X, 100, '100000000', TOK_DEC, 'POOL'),
            sysTransfer(WALLET, 'POOL', 2_000_000_000),
          ],
        },
      ],
      preBalances: [12_000_000_000, 0, 0, 0],
      postBalances: [10_000_000_000, 0, 0, 0],
      preTokenBalances: [tb(1, MINT_X, 'POOL', '100000000', TOK_DEC)],
      postTokenBalances: [tb(2, MINT_X, WALLET, '100000000', TOK_DEC)],
    });
    const hand: EnhancedTx = {
      signature: SIG,
      timestamp: TS,
      type: 'SWAP',
      tokenTransfers: [
        { mint: MINT_X, fromUserAccount: 'POOL', toUserAccount: WALLET, tokenAmount: 100 },
      ],
      nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: 'POOL', amount: 2_000_000_000 }],
      accountData: [
        { account: WALLET, nativeBalanceChange: -2_000_000_000, tokenBalanceChanges: [] },
      ],
      instructions: [],
    };
    expectParserParity(synth, hand, WALLET);
    expect(extractSwapRows(synth, WALLET)).toEqual([
      {
        wallet: WALLET,
        signature: SIG,
        ts: TS,
        mint: MINT_X,
        tokenAmount: 100,
        solAmount: 2,
        side: 'buy',
      },
    ]);
    expect(extractFlowRow(synth, WALLET)?.solFlow).toBeCloseTo(-2, 9);
  });

  it('multi-hop route where a USDC intermediate transits the wallet ATA must NET OUT (not be dropped)', () => {
    // WHY: a Jupiter X→USDC→SOL route makes USDC arrive then leave the wallet's own ATA. If owner
    // resolution is wrong, the USDC leg looks one-directional and the tx is wrongly seen as a 2-mint
    // batched sell (→ dropped). Correct owner resolution nets USDC to 0 so only MINT_X is the sold token.
    const synth = ptx({
      accountKeys: [WALLET, 'WX_ATA', 'P1_X_ATA', 'P1_USDC_ATA', 'W_USDC_ATA', 'P2_USDC_ATA', 'P2'],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            splTransferChecked('WX_ATA', 'P1_X_ATA', MINT_X, 100, '100000000', TOK_DEC, WALLET),
            splTransferChecked('P1_USDC_ATA', 'W_USDC_ATA', USDC, 500, '500000000', TOK_DEC, 'P1'),
            splTransferChecked(
              'W_USDC_ATA',
              'P2_USDC_ATA',
              USDC,
              500,
              '500000000',
              TOK_DEC,
              WALLET,
            ),
            sysTransfer('P2', WALLET, 2_500_000_000),
          ],
        },
      ],
      preBalances: [10_000_000_000, 0, 0, 0, 0, 0, 0],
      postBalances: [12_500_000_000, 0, 0, 0, 0, 0, 0],
      preTokenBalances: [
        tb(1, MINT_X, WALLET, '100000000', TOK_DEC),
        tb(4, USDC, WALLET, '0', TOK_DEC),
      ],
      postTokenBalances: [
        tb(2, MINT_X, 'P1', '100000000', TOK_DEC),
        tb(4, USDC, WALLET, '0', TOK_DEC), // net 0 through the wallet ATA
      ],
    });
    const hand: EnhancedTx = {
      signature: SIG,
      timestamp: TS,
      type: 'SWAP',
      tokenTransfers: [
        { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'P1', tokenAmount: 100 },
        { mint: USDC, fromUserAccount: 'P1', toUserAccount: WALLET, tokenAmount: 500 },
        { mint: USDC, fromUserAccount: WALLET, toUserAccount: 'P2', tokenAmount: 500 },
      ],
      nativeTransfers: [{ fromUserAccount: 'P2', toUserAccount: WALLET, amount: 2_500_000_000 }],
      accountData: [
        { account: WALLET, nativeBalanceChange: 2_500_000_000, tokenBalanceChanges: [] },
      ],
      instructions: [],
    };
    expectParserParity(synth, hand, WALLET);
    expect(extractSwapRows(synth, WALLET)).toEqual([
      {
        wallet: WALLET,
        signature: SIG,
        ts: TS,
        mint: MINT_X,
        tokenAmount: 100,
        solAmount: 2.5,
        side: 'sell',
      },
    ]);
  });

  it('2-mint batched sell → NO row (unattributable), identical to the parser returning null', () => {
    // WHY: when two distinct mints both leave the wallet for SOL, the per-token SOL split is not
    // recoverable; the parser returns null and we must emit nothing (never a guessed split).
    const synth = ptx({
      accountKeys: [WALLET, 'WX_ATA', 'WY_ATA', 'POOL'],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            splTransferChecked('WX_ATA', 'POOL', MINT_X, 100, '100000000', TOK_DEC, WALLET),
            splTransferChecked('WY_ATA', 'POOL', MINT_Y, 50, '50000000', TOK_DEC, WALLET),
            sysTransfer('POOL', WALLET, 5_000_000_000),
          ],
        },
      ],
      preBalances: [10_000_000_000, 0, 0, 0],
      postBalances: [15_000_000_000, 0, 0, 0],
      preTokenBalances: [
        tb(1, MINT_X, WALLET, '100000000', TOK_DEC),
        tb(2, MINT_Y, WALLET, '50000000', TOK_DEC),
      ],
      postTokenBalances: [],
    });
    const hand: EnhancedTx = {
      signature: SIG,
      timestamp: TS,
      type: 'SWAP',
      tokenTransfers: [
        { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'POOL', tokenAmount: 100 },
        { mint: MINT_Y, fromUserAccount: WALLET, toUserAccount: 'POOL', tokenAmount: 50 },
      ],
      nativeTransfers: [{ fromUserAccount: 'POOL', toUserAccount: WALLET, amount: 5_000_000_000 }],
      accountData: [
        { account: WALLET, nativeBalanceChange: 5_000_000_000, tokenBalanceChanges: [] },
      ],
      instructions: [],
    };
    expectParserParity(synth, hand, WALLET);
    expect(parseSwapSell(hand, WALLET)).toBeNull(); // guard: the case really is unattributable
    expect(extractSwapRows(synth, WALLET)).toEqual([]);
  });

  it('WSOL multi-hop netting → routing WSOL hops cancel, proceeds = net WSOL in', () => {
    // WHY: a WSOL route makes the wallet's WSOL ATA both receive and send WSOL; only the NET inflow is
    // the real proceeds. Both the swap row (tokenTransfers netting) and the flow row (WSOL balance
    // change) must land on the same 3.0 SOL.
    const synth = ptx({
      accountKeys: [WALLET, 'WX_ATA', 'P1_X_ATA', 'P2_WSOL_ATA', 'W_WSOL_ATA', 'P3_WSOL_ATA'],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            splTransferChecked('WX_ATA', 'P1_X_ATA', MINT_X, 100, '100000000', TOK_DEC, WALLET),
            splTransferChecked(
              'P2_WSOL_ATA',
              'W_WSOL_ATA',
              SOL_MINT,
              3,
              '3000000000',
              WSOL_DEC,
              'P2',
            ),
            splTransferChecked(
              'W_WSOL_ATA',
              'P3_WSOL_ATA',
              SOL_MINT,
              0.5,
              '500000000',
              WSOL_DEC,
              WALLET,
            ),
            splTransferChecked(
              'P3_WSOL_ATA',
              'W_WSOL_ATA',
              SOL_MINT,
              0.5,
              '500000000',
              WSOL_DEC,
              'P3',
            ),
          ],
        },
      ],
      preBalances: [10_000_000_000, 0, 0, 0, 2_000_000, 0],
      postBalances: [10_000_000_000, 0, 0, 0, 2_000_000, 0],
      preTokenBalances: [
        tb(1, MINT_X, WALLET, '100000000', TOK_DEC),
        tb(4, SOL_MINT, WALLET, '0', WSOL_DEC),
      ],
      postTokenBalances: [
        tb(2, MINT_X, 'P1', '100000000', TOK_DEC),
        tb(4, SOL_MINT, WALLET, '3000000000', WSOL_DEC), // net +3 WSOL through the wallet ATA
      ],
    });
    const hand: EnhancedTx = {
      signature: SIG,
      timestamp: TS,
      type: 'SWAP',
      tokenTransfers: [
        { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'P1', tokenAmount: 100 },
        { mint: SOL_MINT, fromUserAccount: 'P2', toUserAccount: WALLET, tokenAmount: 3 },
        { mint: SOL_MINT, fromUserAccount: WALLET, toUserAccount: 'P3', tokenAmount: 0.5 },
        { mint: SOL_MINT, fromUserAccount: 'P3', toUserAccount: WALLET, tokenAmount: 0.5 },
      ],
      nativeTransfers: [],
      accountData: [
        { account: WALLET, nativeBalanceChange: 0, tokenBalanceChanges: [] },
        {
          account: 'W_WSOL_ATA',
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: SOL_MINT,
              rawTokenAmount: { tokenAmount: '3000000000', decimals: WSOL_DEC },
            },
          ],
        },
      ],
      instructions: [],
    };
    expectParserParity(synth, hand, WALLET);
    expect(extractSwapRows(synth, WALLET)).toEqual([
      {
        wallet: WALLET,
        signature: SIG,
        ts: TS,
        mint: MINT_X,
        tokenAmount: 100,
        solAmount: 3,
        side: 'sell',
      },
    ]);
    expect(extractFlowRow(synth, WALLET)?.solFlow).toBeCloseTo(3, 9);
  });

  it('native-only proceeds with a native OUT leg → proceeds = net native (in − out)', () => {
    // WHY: with no WSOL leg the parser falls back to NET native; an out leg (fee/rent) must be subtracted,
    // not ignored. Proves the native-netting branch and that the flow row mirrors the same net.
    const synth = ptx({
      accountKeys: [WALLET, 'WX_ATA', 'POOL', 'SINK'],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            splTransferChecked('WX_ATA', 'POOL', MINT_X, 100, '100000000', TOK_DEC, WALLET),
            sysTransfer('POOL', WALLET, 2_000_000_000),
            sysTransfer(WALLET, 'SINK', 100_000_000),
          ],
        },
      ],
      preBalances: [10_000_000_000, 0, 0, 0],
      postBalances: [11_900_000_000, 0, 0, 0],
      preTokenBalances: [tb(1, MINT_X, WALLET, '100000000', TOK_DEC)],
      postTokenBalances: [],
    });
    const hand: EnhancedTx = {
      signature: SIG,
      timestamp: TS,
      type: 'SWAP',
      tokenTransfers: [
        { mint: MINT_X, fromUserAccount: WALLET, toUserAccount: 'POOL', tokenAmount: 100 },
      ],
      nativeTransfers: [
        { fromUserAccount: 'POOL', toUserAccount: WALLET, amount: 2_000_000_000 },
        { fromUserAccount: WALLET, toUserAccount: 'SINK', amount: 100_000_000 },
      ],
      accountData: [
        { account: WALLET, nativeBalanceChange: 1_900_000_000, tokenBalanceChanges: [] },
      ],
      instructions: [],
    };
    expectParserParity(synth, hand, WALLET);
    expect(extractSwapRows(synth, WALLET)).toEqual([
      {
        wallet: WALLET,
        signature: SIG,
        ts: TS,
        mint: MINT_X,
        tokenAmount: 100,
        solAmount: 1.9,
        side: 'sell',
      },
    ]);
    expect(extractFlowRow(synth, WALLET)?.solFlow).toBeCloseTo(1.9, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3) Flow row — trading flag (DLMM-touch path reconstructed) + the documented `type` gap.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('extractFlowRow — trading classification', () => {
  it('marks a DLMM-touching tx as trading via the reconstructed instruction programIds (top-level)', () => {
    const synth = ptx({
      accountKeys: [WALLET, 'POSITION'],
      topInstructions: [opaqueIx(DLMM_PROGRAM_ID)],
      innerInstructions: [
        { index: 0, instructions: [sysTransfer('POSITION', WALLET, 1_000_000_000)] },
      ],
      preBalances: [10_000_000_000, 0],
      postBalances: [11_000_000_000, 0],
    });
    const row = extractFlowRow(synth, WALLET);
    expect(row).toMatchObject({ signature: SIG, timestamp: TS, isTrading: true });
    expect(row?.solFlow).toBeCloseTo(1, 9);
  });

  it('marks a DLMM CPI (inner instruction) as trading too', () => {
    const synth = ptx({
      accountKeys: [WALLET],
      topInstructions: [opaqueIx('ROUTER_PROGRAM')],
      innerInstructions: [{ index: 0, instructions: [opaqueIx(DLMM_PROGRAM_ID)] }],
      preBalances: [10_000_000_000],
      postBalances: [10_000_000_000],
    });
    expect(extractFlowRow(synth, WALLET)?.isTrading).toBe(true);
  });

  it('marks a non-DLMM swap as trading from the token movement, without Helius `type`', () => {
    // WHY: `type` is the one Enhanced field that cannot be derived offline, so the trading flag is
    // STRUCTURAL — a non-SOL token left the wallet, which no plain SOL transfer ever does. Deriving it
    // from `type` instead would file every Jupiter swap as an external transfer and drop its proceeds
    // from the PnL curve. Verified against Helius's own labels on 200 real txs.
    const synth = ptx({
      accountKeys: [WALLET, 'WX_ATA', 'POOL'],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            splTransferChecked('WX_ATA', 'POOL', MINT_X, 100, '100000000', TOK_DEC, WALLET),
            sysTransfer('POOL', WALLET, 2_000_000_000),
          ],
        },
      ],
      preBalances: [10_000_000_000, 0, 0],
      postBalances: [12_000_000_000, 0, 0],
      preTokenBalances: [tb(1, MINT_X, WALLET, '100000000', TOK_DEC)],
      postTokenBalances: [],
    });
    const row = extractFlowRow(synth, WALLET);
    expect(row?.isTrading).toBe(true);
    expect(row?.solFlow).toBeCloseTo(2, 9);
  });

  it('keeps a WSOL-only movement out of the trading flag (SOL is not a traded token)', () => {
    // Wrapping/unwrapping SOL is not a trade. Only a NON-SOL mint moving marks trading, otherwise every
    // wrap would be misfiled and a plain funding transfer routed through WSOL would pollute the curve.
    const synth = ptx({
      accountKeys: [WALLET, 'WSOL_ATA', 'CEX'],
      topInstructions: [splTransferChecked('WSOL_ATA', 'CEX', SOL_MINT, 1, '1000000000', WSOL_DEC)],
      preBalances: [10_000_000_000, 0, 0],
      postBalances: [9_000_000_000, 0, 0],
      preTokenBalances: [tb(1, SOL_MINT, WALLET, '1000000000', WSOL_DEC)],
      postTokenBalances: [tb(1, SOL_MINT, WALLET, '0', WSOL_DEC)],
    });
    expect(extractFlowRow(synth, WALLET)?.isTrading).toBe(false);
  });

  it('emits a row for a plain external SOL transfer (isTrading=false), exactly as pageFlows would', () => {
    const synth = ptx({
      accountKeys: [WALLET, 'CEX'],
      topInstructions: [sysTransfer(WALLET, 'CEX', 5_000_000_000)],
      preBalances: [10_000_000_000, 0],
      postBalances: [5_000_000_000, 0],
    });
    expect(extractFlowRow(synth, WALLET)).toMatchObject({ isTrading: false, type: 'UNKNOWN' });
    expect(extractFlowRow(synth, WALLET)?.solFlow).toBeCloseTo(-5, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4) Defensive — degenerate inputs must yield [] / null without throwing.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('ephemeral token accounts — owner declared by the instructions', () => {
  it('attributes a WSOL leg opened AND closed in-tx to its owner, so the sell is still seen', () => {
    // WHY: routers open a throwaway wrapped-SOL account, swap through it, then close it. Such an account
    // is in NEITHER preTokenBalances nor postTokenBalances, so the balance-derived owner map misses it
    // and the WSOL leg gets attributed to the raw account address — netting the proceeds to zero and
    // making the sale vanish. Measured on real Jupiter swaps before the instruction-harvest fix.
    const synth = ptx({
      accountKeys: [WALLET, 'TMP_WSOL', 'POOL', 'TOK_ATA'],
      topInstructions: [
        {
          program: 'spl-token',
          programId: TOKEN_PROGRAM_ID,
          parsed: {
            type: 'initializeAccount3',
            info: { account: 'TMP_WSOL', mint: SOL_MINT, owner: WALLET },
          },
        },
        splTransferChecked('TOK_ATA', 'POOL', MINT_X, 100, '100000000', TOK_DEC, WALLET),
        splTransferChecked('POOL', 'TMP_WSOL', SOL_MINT, 2, '2000000000', WSOL_DEC),
        {
          program: 'spl-token',
          programId: TOKEN_PROGRAM_ID,
          parsed: {
            type: 'closeAccount',
            info: { account: 'TMP_WSOL', destination: WALLET, owner: WALLET },
          },
        },
      ],
      preBalances: [10_000_000_000, 0, 0, 0],
      postBalances: [12_000_000_000, 0, 0, 0],
      preTokenBalances: [tb(3, MINT_X, WALLET, '100000000', TOK_DEC)],
      postTokenBalances: [],
    });

    const enhanced = parsedTxToEnhancedTx(synth);
    const wsolLeg = enhanced.tokenTransfers?.find((t) => t.mint === SOL_MINT);
    expect(wsolLeg?.toUserAccount).toBe(WALLET); // NOT 'TMP_WSOL'

    const rows = extractSwapRows(synth, WALLET);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mint: MINT_X, side: 'sell', tokenAmount: 100 });
    expect(rows[0]?.solAmount).toBeCloseTo(2, 9);
  });

  it('never lets a declared owner override what the balances already proved', () => {
    // The balances are authoritative; an instruction-declared owner only FILLS a gap. Otherwise a
    // misleading `closeAccount` destination could re-attribute a counterparty's leg to our wallet.
    const synth = ptx({
      accountKeys: [WALLET, 'POOL_ATA', 'POOL'],
      topInstructions: [
        splTransferChecked('POOL_ATA', 'POOL', MINT_X, 5, '5000000', TOK_DEC),
        {
          program: 'spl-token',
          programId: TOKEN_PROGRAM_ID,
          parsed: {
            type: 'closeAccount',
            info: { account: 'POOL_ATA', destination: WALLET, owner: WALLET },
          },
        },
      ],
      preBalances: [10_000_000_000, 0, 0],
      postBalances: [10_000_000_000, 0, 0],
      preTokenBalances: [tb(1, MINT_X, 'SOMEONE_ELSE', '5000000', TOK_DEC)],
      postTokenBalances: [],
    });
    const leg = parsedTxToEnhancedTx(synth).tokenTransfers?.[0];
    expect(leg?.fromUserAccount).toBe('SOMEONE_ELSE');
  });
});

describe('extractSwapRows — market swaps only', () => {
  const withdrawIx = () => dlmmIx('remove_liquidity_by_range2');

  it('does NOT fabricate a buy from a DLMM withdraw', () => {
    // WHY: a withdraw returns tokens to the wallet while it pays rent/fees in SOL. Read naively that is
    // "bought N tokens for 0.00003 SOL" — a near-zero cost basis that would massively overstate realized
    // profit when those tokens are later sold. Observed on real withdraws (106 697 tokens for 0.000028 SOL).
    const synth = ptx({
      accountKeys: [WALLET, 'POS', 'TOK_ATA'],
      topInstructions: [withdrawIx()],
      innerInstructions: [
        {
          index: 0,
          instructions: [splTransferChecked('POS', 'TOK_ATA', MINT_X, 1000, '1000000000', TOK_DEC)],
        },
      ],
      preBalances: [10_000_000_000, 0, 0],
      postBalances: [9_999_970_000, 0, 0], // paid rent + fee
      preTokenBalances: [tb(2, MINT_X, WALLET, '0', TOK_DEC)],
      postTokenBalances: [tb(2, MINT_X, WALLET, '1000000000', TOK_DEC)],
    });
    expect(extractSwapRows(synth, WALLET)).toEqual([]);
  });

  it('DOES keep a real swap that an aggregator routed through a DLMM pool', () => {
    // WHY: the DLMM program also appears when Jupiter routes a trade through a Meteora pool. Guarding on
    // mere program presence silently dropped a real 0.97 SOL sale — the discriminator is the instruction
    // KIND, so `swap2` stays a swap while position instructions do not.
    const synth = ptx({
      accountKeys: [WALLET, 'TOK_ATA', 'POOL', 'WSOL_ATA'],
      topInstructions: [dlmmIx('swap2')],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            splTransferChecked('TOK_ATA', 'POOL', MINT_X, 50, '50000000', TOK_DEC, WALLET),
            splTransferChecked('POOL', 'WSOL_ATA', SOL_MINT, 1, '1000000000', WSOL_DEC),
          ],
        },
      ],
      preBalances: [10_000_000_000, 0, 0, 0],
      postBalances: [11_000_000_000, 0, 0, 0],
      preTokenBalances: [
        tb(1, MINT_X, WALLET, '50000000', TOK_DEC),
        tb(3, SOL_MINT, WALLET, '0', WSOL_DEC),
      ],
      postTokenBalances: [tb(3, SOL_MINT, WALLET, '1000000000', WSOL_DEC)],
    });
    const rows = extractSwapRows(synth, WALLET);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mint: MINT_X, side: 'sell' });
    expect(rows[0]?.solAmount).toBeCloseTo(1, 9);
  });
});

describe('extractSwapRows / extractFlowRow — defensive', () => {
  it('rejects a FAILED tx — its instructions ran but moved nothing but the fee', () => {
    // WHY: `message.instructions` is populated even for a failed tx, so reducing one synthesises
    // transfers that never happened. Rejecting here rather than trusting every caller to pre-filter.
    const synth = ptx({
      err: { InstructionError: [0, 'Custom'] },
      accountKeys: [WALLET, 'TOK_ATA', 'POOL'],
      topInstructions: [
        splTransferChecked('TOK_ATA', 'POOL', MINT_X, 100, '100000000', TOK_DEC, WALLET),
        sysTransfer('POOL', WALLET, 2_000_000_000),
      ],
      preBalances: [10_000_000_000, 0, 0],
      postBalances: [9_999_995_000, 0, 0],
      preTokenBalances: [tb(1, MINT_X, WALLET, '100000000', TOK_DEC)],
    });
    expect(extractSwapRows(synth, WALLET)).toEqual([]);
    expect(extractFlowRow(synth, WALLET)).toBeNull();
  });

  it('rejects a tx with no blockTime rather than dating it at epoch 0', () => {
    // WHY: ts=0 lands in the 1970 day bucket, which becomes the curve's first day and back-fills ~20 000
    // empty days. A row we cannot date is worse than no row.
    const synth = ptx({
      blockTime: null,
      accountKeys: [WALLET, 'CEX'],
      topInstructions: [sysTransfer(WALLET, 'CEX', 1_000_000_000)],
      preBalances: [10_000_000_000, 0],
      postBalances: [9_000_000_000, 0],
    });
    expect(extractFlowRow(synth, WALLET)).toBeNull();
  });

  it('null meta → [] swap rows and null flow row, no throw', () => {
    const synth = ptx({ accountKeys: [], nullMeta: true });
    expect(extractSwapRows(synth, WALLET)).toEqual([]);
    expect(extractFlowRow(synth, WALLET)).toBeNull();
  });

  it('empty / degenerate tx → [] and null, no throw', () => {
    const empty = {} as unknown as ParsedTransactionWithMeta;
    expect(extractSwapRows(empty, WALLET)).toEqual([]);
    expect(extractFlowRow(empty, WALLET)).toBeNull();
  });
});
