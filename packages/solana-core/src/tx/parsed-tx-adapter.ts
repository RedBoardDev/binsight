import type {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { SOL_MINT } from '../constants';
import { hasDlmmPositionInstruction } from '../dlmm/position-instructions';
import type { SwapFlowRow, WalletFlowRow } from '../types';
import {
  type EnhancedTx,
  parseSwapBuy,
  parseSwapSell,
  touchesDlmm,
  walletSolFlow,
} from './swap-legs';

/**
 * PURE, OFFLINE adapter that rebuilds, from a plain Solana `getParsedTransaction` (jsonParsed) result,
 * the Helius-shaped transaction the wallet parsers ({@link parseSwapSell}, {@link parseSwapBuy},
 * {@link walletSolFlow}) were written and validated against. It never re-implements swap/flow logic; it
 * only reshapes the raw on-chain transaction into an {@link EnhancedTx}.
 *
 * Reconstructable from getParsedTransaction: tokenTransfers, nativeTransfers, accountData, instructions
 * (programId only), signature, timestamp. NOT reconstructable: Helius's proprietary `type` taxonomy
 * (SWAP / TRANSFER / ...) — it is a heuristic classification with no on-chain field. We set `type` to a
 * neutral sentinel (see {@link RECONSTRUCTED_TX_TYPE}); the consequence on the trading flag is documented
 * on {@link extractFlowRow}.
 */

/** Helius's `type` taxonomy cannot be derived from raw chain data, so the rebuilt tx carries this. */
const RECONSTRUCTED_TX_TYPE = 'UNKNOWN';

// `program` tags emitted by getParsedTransaction (jsonParsed) for the programs we read. Matching the
// parsed tag is the canonical way to recognise these instructions; an instruction the RPC could not
// parse arrives as PartiallyDecoded (no `parsed`) and carries no movement we can attribute.
const SPL_TOKEN_PROGRAM = 'spl-token';
const SPL_TOKEN_2022_PROGRAM = 'spl-token-2022'; // Token-2022 transfers are equally relevant
const SYSTEM_PROGRAM = 'system';
const ATA_PROGRAM = 'spl-associated-token-account';

// SPL-Token instruction variants that move tokens between token accounts.
const SPL_TRANSFER = 'transfer'; // bare: no mint/decimals in the ix → resolved from token balances
const SPL_TRANSFER_CHECKED = 'transferChecked'; // carries mint + decimals in the ix
// SPL-Token / ATA instruction variants that DECLARE a token account's owner. Harvesting these is what
// resolves EPHEMERAL accounts — a wrapped-SOL account a router opens and closes inside the same tx
// appears in NEITHER preTokenBalances nor postTokenBalances, so the balance-derived owner map misses it
// entirely and every leg through it would be attributed to the raw account address instead of the
// wallet. That silently zeroed the WSOL leg of every Jupiter swap (measured: 17/42 sampled txs).
const SPL_INIT_ACCOUNT = new Set(['initializeAccount', 'initializeAccount2', 'initializeAccount3']);
const SPL_CLOSE_ACCOUNT = 'closeAccount';
const ATA_CREATE = new Set(['create', 'createIdempotent']);
// System-Program instruction variants that move native SOL between accounts.
const SYS_TRANSFER = 'transfer';
const SYS_TRANSFER_WITH_SEED = 'transferWithSeed';

const TOKEN_DECIMALS_BASE = 10; // raw amount → human amount = raw / 10 ** decimals
const EMPTY_RAW = 0n; // missing pre/post side of a token balance = no tokens on that side

type AnyParsedIx = ParsedInstruction | PartiallyDecodedInstruction;

/** ParsedInstruction type guard (PartiallyDecodedInstruction has no `parsed`/`program`). */
function isParsed(ix: AnyParsedIx): ix is ParsedInstruction {
  return 'parsed' in ix && 'program' in ix;
}

/** The program id of any parsed/partially-decoded instruction, as a base-58 string. */
function programIdOf(ix: AnyParsedIx): string {
  return 'programId' in ix ? (ix.programId?.toString() ?? '') : '';
}

/** Every instruction in execution order: top-level message instructions + all inner (CPI) instructions. */
function allInstructions(tx: ParsedTransactionWithMeta): AnyParsedIx[] {
  const out: AnyParsedIx[] = [...(tx?.transaction?.message?.instructions ?? [])];
  for (const group of tx?.meta?.innerInstructions ?? []) out.push(...group.instructions);
  return out;
}

/** accountKeys[i].pubkey as a string, or undefined when the index is out of range. */
function accountKeyAt(tx: ParsedTransactionWithMeta, index: number): string | undefined {
  return tx?.transaction?.message?.accountKeys?.[index]?.pubkey?.toString();
}

/**
 * Resolve token-account → owner and token-account → {mint, decimals} from pre/postTokenBalances.
 * Each balance entry's `accountIndex` indexes into `accountKeys`, and carries the account's `owner`,
 * `mint`, and `decimals`. This is how we recover the OWNER wallets that Helius reports as
 * from/toUserAccount, and the mint/decimals a bare `transfer` instruction omits.
 */
function buildTokenAccountMaps(tx: ParsedTransactionWithMeta): {
  ownerOf: Map<string, string>;
  mintDecOf: Map<string, { mint: string; decimals: number }>;
  decimalsOfMint: Map<string, number>;
} {
  const ownerOf = new Map<string, string>();
  const mintDecOf = new Map<string, { mint: string; decimals: number }>();
  // Mint → decimals, learned from ANY account holding that mint in this tx. Lets a bare `transfer`
  // through an ephemeral account (absent from the balances) still be scaled correctly.
  const decimalsOfMint = new Map<string, number>();
  const balances = [...(tx?.meta?.preTokenBalances ?? []), ...(tx?.meta?.postTokenBalances ?? [])];
  for (const b of balances) {
    const account = accountKeyAt(tx, b.accountIndex);
    if (account == null) continue;
    if (b.owner != null) ownerOf.set(account, b.owner);
    if (!mintDecOf.has(account))
      mintDecOf.set(account, { mint: b.mint, decimals: b.uiTokenAmount.decimals });
    if (!decimalsOfMint.has(b.mint)) decimalsOfMint.set(b.mint, b.uiTokenAmount.decimals);
  }
  // Second pass: harvest owner/mint DECLARED by the instructions themselves. An account created and
  // closed inside this tx never reaches the balances, so this is the only place its owner is stated.
  // Balance-derived entries win (set first, and we never overwrite them below).
  harvestDeclaredOwners(tx, ownerOf, mintDecOf, decimalsOfMint);
  return { ownerOf, mintDecOf, decimalsOfMint };
}

/**
 * Fill `ownerOf` / `mintDecOf` from the instructions that DECLARE a token account's owner and mint:
 * `initializeAccount*` and the ATA program's `create`/`createIdempotent` name both, `closeAccount`
 * names the owner of an account being torn down. This is what makes an ephemeral wrapped-SOL account
 * (opened + closed within the tx, so invisible to pre/postTokenBalances) resolve to its real owner
 * instead of leaking the raw account address into from/toUserAccount.
 */
function harvestDeclaredOwners(
  tx: ParsedTransactionWithMeta,
  ownerOf: Map<string, string>,
  mintDecOf: Map<string, { mint: string; decimals: number }>,
  decimalsOfMint: Map<string, number>,
): void {
  const note = (account?: string, owner?: string, mint?: string): void => {
    if (account == null) return;
    // Never override what the balances already proved — they are the authoritative source.
    if (owner != null && !ownerOf.has(account)) ownerOf.set(account, owner);
    if (mint != null && !mintDecOf.has(account)) {
      const decimals = decimalsOfMint.get(mint);
      if (decimals != null) mintDecOf.set(account, { mint, decimals });
    }
  };
  for (const ix of allInstructions(tx)) {
    if (!isParsed(ix)) continue;
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    const type = parsed?.type;
    const info = parsed?.info ?? {};
    if (ix.program === SPL_TOKEN_PROGRAM || ix.program === SPL_TOKEN_2022_PROGRAM) {
      if (type != null && SPL_INIT_ACCOUNT.has(type)) {
        note(info.account as string, info.owner as string, info.mint as string);
      } else if (type === SPL_CLOSE_ACCOUNT) {
        // `owner` is the authority closing it; `destination` receives the lamports (the unwrap target).
        note(info.account as string, (info.owner ?? info.destination) as string, undefined);
      }
    } else if (ix.program === ATA_PROGRAM && type != null && ATA_CREATE.has(type)) {
      note(info.account as string, (info.wallet ?? info.source) as string, info.mint as string);
    }
  }
}

function toHumanAmount(rawAmount: string | number | undefined, decimals: number): number {
  if (rawAmount == null) return Number.NaN;
  return Number(rawAmount) / TOKEN_DECIMALS_BASE ** decimals;
}

/**
 * Reconstruct {mint, fromUserAccount, toUserAccount, tokenAmount} for every SPL-Token transfer /
 * transferChecked (top-level + inner). from/toUserAccount are the OWNER wallets of the source/destination
 * token accounts (the wallet, not the ATA) — resolved via the owner map, with the instruction `authority`
 * as the source fallback (Helius reports owners; a source ATA is virtually always in preTokenBalances, so
 * the fallback is for pathological inputs only). For a bare `transfer` the ix omits mint+decimals, so they
 * are resolved from the token account's balance entry and the raw amount is decimal-adjusted; an
 * unresolvable bare transfer is skipped (it cannot be attributed to a mint anyway).
 */
function extractTokenTransfers(
  tx: ParsedTransactionWithMeta,
  ownerOf: Map<string, string>,
  mintDecOf: Map<string, { mint: string; decimals: number }>,
  decimalsOfMint: Map<string, number>,
): NonNullable<EnhancedTx['tokenTransfers']> {
  const out: NonNullable<EnhancedTx['tokenTransfers']> = [];
  for (const ix of allInstructions(tx)) {
    if (!isParsed(ix)) continue;
    if (ix.program !== SPL_TOKEN_PROGRAM && ix.program !== SPL_TOKEN_2022_PROGRAM) continue;
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    const type = parsed?.type;
    if (type !== SPL_TRANSFER && type !== SPL_TRANSFER_CHECKED) continue;
    const info = parsed?.info ?? {};
    const source = info.source as string | undefined;
    const destination = info.destination as string | undefined;
    if (source == null || destination == null) continue;
    const authority = (info.authority ?? info.multisigAuthority) as string | undefined;
    const fromUserAccount = ownerOf.get(source) ?? authority ?? source;
    const toUserAccount = ownerOf.get(destination) ?? destination;

    let mint: string | undefined;
    let tokenAmount: number;
    if (type === SPL_TRANSFER_CHECKED) {
      mint = info.mint as string | undefined;
      const ta = info.tokenAmount as
        | { amount?: string; decimals?: number; uiAmount?: number | null }
        | undefined;
      tokenAmount =
        ta?.uiAmount != null ? ta.uiAmount : toHumanAmount(ta?.amount, ta?.decimals ?? 0);
    } else {
      // Bare transfer: the ix has only a raw `amount`; recover mint+decimals from either token account
      // (the counterparty resolves it when one side is an ephemeral account absent from the balances).
      const md = mintDecOf.get(source) ?? mintDecOf.get(destination);
      if (md == null) continue; // no mint resolvable → not attributable; skip rather than invent one
      mint = md.mint;
      // Prefer the mint's own decimals when known — an account entry can carry a stale/other scale.
      tokenAmount = toHumanAmount(
        info.amount as string | undefined,
        decimalsOfMint.get(md.mint) ?? md.decimals,
      );
    }
    if (mint == null || !Number.isFinite(tokenAmount)) continue;
    out.push({ mint, fromUserAccount, toUserAccount, tokenAmount });
  }
  return out;
}

/**
 * Reconstruct {fromUserAccount, toUserAccount, amount(lamports)} for every System-Program transfer /
 * transferWithSeed (top-level + inner). These are the explicit native-SOL movements the parsers net for
 * proceeds when no WSOL leg is present.
 */
function extractNativeTransfers(
  tx: ParsedTransactionWithMeta,
): NonNullable<EnhancedTx['nativeTransfers']> {
  const out: NonNullable<EnhancedTx['nativeTransfers']> = [];
  for (const ix of allInstructions(tx)) {
    if (!isParsed(ix)) continue;
    if (ix.program !== SYSTEM_PROGRAM) continue;
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    const type = parsed?.type;
    if (type !== SYS_TRANSFER && type !== SYS_TRANSFER_WITH_SEED) continue;
    const info = parsed?.info ?? {};
    const source = info.source as string | undefined;
    const destination = info.destination as string | undefined;
    const lamports = info.lamports as number | string | undefined;
    if (source == null || destination == null || lamports == null) continue;
    out.push({ fromUserAccount: source, toUserAccount: destination, amount: Number(lamports) });
  }
  return out;
}

/**
 * Reconstruct each accountKeys[i]'s {account, nativeBalanceChange, tokenBalanceChanges}. nativeBalanceChange
 * is postBalances[i]-preBalances[i]; tokenBalanceChanges are the raw post-pre diffs of the token balances
 * sitting at that account index (matched by accountIndex+mint, unioning pre and post so created/closed
 * accounts are captured), tagged with the OWNER as userAccount — exactly what walletSolFlow reads.
 */
function extractAccountData(tx: ParsedTransactionWithMeta): NonNullable<EnhancedTx['accountData']> {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const pre = tx?.meta?.preBalances ?? [];
  const post = tx?.meta?.postBalances ?? [];
  const tokenChangesByIndex = buildTokenBalanceChanges(tx);
  const out: NonNullable<EnhancedTx['accountData']> = [];
  for (let i = 0; i < keys.length; i++) {
    const account = keys[i]?.pubkey?.toString();
    if (account == null) continue;
    out.push({
      account,
      nativeBalanceChange: (post[i] ?? 0) - (pre[i] ?? 0),
      tokenBalanceChanges: tokenChangesByIndex.get(i) ?? [],
    });
  }
  return out;
}

/** Per-account-index list of token-balance diffs, matching pre/postTokenBalances by accountIndex+mint. */
function buildTokenBalanceChanges(
  tx: ParsedTransactionWithMeta,
): Map<number, NonNullable<NonNullable<EnhancedTx['accountData']>[number]['tokenBalanceChanges']>> {
  type Acc = {
    accountIndex: number;
    mint: string;
    owner?: string;
    decimals: number;
    preRaw: bigint;
    postRaw: bigint;
  };
  const byKey = new Map<string, Acc>();
  const upsert = (
    entry: {
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: { amount: string; decimals: number };
    },
    side: 'pre' | 'post',
  ) => {
    const key = `${entry.accountIndex}:${entry.mint}`;
    const acc = byKey.get(key) ?? {
      accountIndex: entry.accountIndex,
      mint: entry.mint,
      owner: entry.owner,
      decimals: entry.uiTokenAmount.decimals,
      preRaw: EMPTY_RAW,
      postRaw: EMPTY_RAW,
    };
    if (entry.owner != null) acc.owner = entry.owner;
    if (side === 'pre') acc.preRaw = BigInt(entry.uiTokenAmount.amount);
    else acc.postRaw = BigInt(entry.uiTokenAmount.amount);
    byKey.set(key, acc);
  };
  for (const b of tx?.meta?.preTokenBalances ?? []) upsert(b, 'pre');
  for (const b of tx?.meta?.postTokenBalances ?? []) upsert(b, 'post');

  const result = new Map<
    number,
    NonNullable<NonNullable<EnhancedTx['accountData']>[number]['tokenBalanceChanges']>
  >();
  for (const acc of byKey.values()) {
    // userAccount is the OWNER (walletSolFlow keys WSOL by owner); fall back to the token-account address
    // when the RPC omitted owner (it virtually never does for jsonParsed token balances).
    const userAccount = acc.owner ?? accountKeyAt(tx, acc.accountIndex) ?? '';
    const change = {
      userAccount,
      mint: acc.mint,
      rawTokenAmount: {
        tokenAmount: (acc.postRaw - acc.preRaw).toString(),
        decimals: acc.decimals,
      },
    };
    const list = result.get(acc.accountIndex) ?? [];
    list.push(change);
    result.set(acc.accountIndex, list);
  }
  return result;
}

/**
 * Reconstruct the {programId, innerInstructions:[{programId}]} shape — only program ids are needed, they
 * feed the DLMM-touch check. Inner instructions are grouped under their top-level instruction by index.
 */
function extractInstructions(
  tx: ParsedTransactionWithMeta,
): NonNullable<EnhancedTx['instructions']> {
  const top = tx?.transaction?.message?.instructions ?? [];
  const innersByIndex = new Map<number, AnyParsedIx[]>();
  for (const group of tx?.meta?.innerInstructions ?? [])
    innersByIndex.set(group.index, group.instructions);
  return top.map((ix, i) => ({
    programId: programIdOf(ix),
    innerInstructions: (innersByIndex.get(i) ?? []).map((inner) => ({
      programId: programIdOf(inner),
    })),
  }));
}

/**
 * Is this tx TRADING activity (counts toward wallet PnL) rather than an external transfer (CEX in/out,
 * funding)? Derived STRUCTURALLY from what actually moved, never from Helius's `type` taxonomy — which
 * is a proprietary heuristic with no on-chain field and is therefore unavailable offline.
 *
 * Trading = the tx touched the DLMM program (deposit/withdraw/claim/close), OR a NON-SOL token entered
 * or left the wallet (every swap does this; a plain SOL funding transfer never does). Measured against
 * Helius's own labels this reproduces the SWAP + DLMM classification exactly on real swaps.
 *
 * Deliberate, immaterial divergence: sending an SPL token to an exchange counts as trading here while
 * Helius calls it TRANSFER. Such a tx carries no SOL beyond its fee, so the PnL curve — which sums
 * `solFlow` over trading txs — moves by ~0.000005 SOL. Erring this way is the safe direction: the
 * opposite error drops a real swap's proceeds out of the curve entirely.
 */
function isTradingTx(tx: EnhancedTx, wallet: string): boolean {
  if (touchesDlmm(tx)) return true;
  return (tx.tokenTransfers ?? []).some(
    (t) => t.mint !== SOL_MINT && (t.fromUserAccount === wallet || t.toUserAccount === wallet),
  );
}

/**
 * Reshape a `getParsedTransaction` (jsonParsed) result into the {@link EnhancedTx} the Helius parsers
 * consume. Defensive against missing/null meta and a malformed/empty tx (returns empty arrays, never
 * throws). `type` is the {@link RECONSTRUCTED_TX_TYPE} sentinel — see the module JSDoc.
 */
export function parsedTxToEnhancedTx(tx: ParsedTransactionWithMeta): EnhancedTx {
  const { ownerOf, mintDecOf, decimalsOfMint } = buildTokenAccountMaps(tx);
  return {
    signature: tx?.transaction?.signatures?.[0] ?? '',
    timestamp: tx?.blockTime ?? 0,
    type: RECONSTRUCTED_TX_TYPE,
    tokenTransfers: extractTokenTransfers(tx, ownerOf, mintDecOf, decimalsOfMint),
    nativeTransfers: extractNativeTransfers(tx),
    accountData: extractAccountData(tx),
    instructions: extractInstructions(tx),
  };
}

/**
 * Derive the wallet's clean swap leg(s) from a parsed tx — run parseSwapSell + parseSwapBuy on the
 * reconstructed EnhancedTx, mapped to {@link SwapFlowRow} rows (sell →
 * side 'sell', solAmount = SOL received; buy → side 'buy', solAmount = SOL spent). A clean SWAP matches
 * at most one parser, so a tx yields 0 or 1 rows; an unattributable tx (batched/multi-mint) yields none.
 */
export function extractSwapRows(tx: ParsedTransactionWithMeta, wallet: string): SwapFlowRow[] {
  // A failed tx moved nothing but its fee; its instructions are still listed, so reducing it would
  // fabricate legs. Reject here rather than depend on every caller pre-filtering.
  if (tx?.meta?.err != null) return [];
  const enhanced = parsedTxToEnhancedTx(tx);
  // MARKET swaps only. The Enhanced path gets this for free from the server-side `?type=SWAP` filter;
  // the on-chain equivalent is "this tx does not act on one of the wallet's own DLMM positions". A
  // withdraw moves POSITION legs — already captured in dlmm_legs — and pairing that token inflow with
  // the rent/fee outflow makes parseSwapBuy fabricate a buy at a near-zero cost basis (measured:
  // 106 697 tokens "bought" for 0.000028 SOL), which would overstate realized profit on the later sale.
  //
  // The test is the instruction KIND, never mere program presence: an aggregator routing a trade
  // through a Meteora pool emits a DLMM `swap` and IS a real market swap (measured: a 0.97 SOL sale
  // that a presence-based guard silently dropped).
  if (hasDlmmPositionInstruction(tx)) return [];
  const rows: SwapFlowRow[] = [];
  const sell = parseSwapSell(enhanced, wallet);
  if (sell)
    rows.push({
      wallet,
      signature: enhanced.signature,
      ts: sell.ts,
      mint: sell.mint,
      tokenAmount: sell.tokenAmount,
      solAmount: sell.solReceived, // SOL received for the sell
      side: 'sell',
    });
  const buy = parseSwapBuy(enhanced, wallet);
  if (buy)
    rows.push({
      wallet,
      signature: enhanced.signature,
      ts: buy.ts,
      mint: buy.mint,
      tokenAmount: buy.tokenAmount,
      solAmount: buy.solReceived, // = SOL spent on the buy (parseSwapBuy returns it as solReceived)
      side: 'buy',
    });
  return rows;
}

/**
 * Derive the wallet's single cash-flow row from a parsed tx: net SOL flow (walletSolFlow) + the trading
 * flag (isTradingTx), tagged with signature + timestamp. Returns null for a degenerate tx with
 * no metadata (nothing reliable to reduce) or no signature (nothing to key a row on); for any real tx —
 * including a plain external transfer — it emits a row.
 *
 * The trading flag is STRUCTURAL, not taxonomic — see {@link isTradingTx}. Helius's `type` is not
 * reconstructable offline, so relying on it here would misfile every non-DLMM swap as an external
 * transfer; the structural signal is derived from the token movements themselves instead.
 */
export function extractFlowRow(
  tx: ParsedTransactionWithMeta,
  wallet: string,
): WalletFlowRow | null {
  if (tx?.meta == null) return null; // no metadata → nothing reliable to reduce into a flow row
  // A FAILED tx changed no state beyond the fee. Its `message.instructions` are still present, so
  // reducing it would synthesise transfers that never happened — reject it outright rather than trust
  // every caller to pre-filter (the leg ingest does; nothing guarantees the next caller will).
  if (tx.meta.err != null) return null;
  const enhanced = parsedTxToEnhancedTx(tx);
  if (!enhanced.signature) return null;
  // A missing blockTime would land the row at epoch 0: `wallet_flow_daily` would gain a 1970 bucket and
  // the PnL curve would back-fill ~20 000 empty days from it. Refuse rather than corrupt the series.
  if (!enhanced.timestamp) return null;
  return {
    signature: enhanced.signature,
    timestamp: enhanced.timestamp,
    type: enhanced.type,
    solFlow: walletSolFlow(enhanced, wallet),
    isTrading: isTradingTx(enhanced, wallet),
  };
}
