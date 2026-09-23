import { DLMM_PROGRAM_ID, SOL_MINT } from '@binsight/shared';
import type { ResidualSell } from '@/domain/dlmm';
import { LAMPORTS_PER_SOL } from '@/domain/dlmm-pnl';

/**
 * Wallet-centric reductions of one transaction: its net SOL flow and its clean swap leg. They run over
 * the Helius-shaped transaction the parsed-tx adapter rebuilds from a plain `getParsedTransaction`
 * (token/native transfers + per-account balance changes), the shape these parsers were first written
 * and validated against.
 */
export interface EnhancedTx {
  timestamp: number;
  signature: string;
  type: string;
  tokenTransfers?: {
    mint: string;
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
  }[];
  nativeTransfers?: { fromUserAccount: string; toUserAccount: string; amount: number }[];
  accountData?: {
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges?: {
      userAccount: string;
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
    }[];
  }[];
  instructions?: { programId: string; innerInstructions?: { programId: string }[] }[];
}

/** The wallet's net SOL+WSOL change in a tx (native balance change + WSOL token-balance change). */
export function walletSolFlow(tx: EnhancedTx, wallet: string): number {
  let lamports = 0;
  let wsol = 0;
  for (const ad of tx.accountData ?? []) {
    if (ad.account === wallet) lamports += ad.nativeBalanceChange ?? 0;
    for (const tb of ad.tokenBalanceChanges ?? []) {
      if (tb.userAccount === wallet && tb.mint === SOL_MINT) {
        wsol += Number(tb.rawTokenAmount.tokenAmount) / 10 ** tb.rawTokenAmount.decimals;
      }
    }
  }
  return lamports / LAMPORTS_PER_SOL + wsol;
}

/** True if the tx invokes the DLMM program at top level or via a CPI (inner instruction). */
export function touchesDlmm(tx: EnhancedTx): boolean {
  for (const ix of tx.instructions ?? []) {
    if (ix.programId === DLMM_PROGRAM_ID) return true;
    for (const inner of ix.innerInstructions ?? []) {
      if (inner.programId === DLMM_PROGRAM_ID) return true;
    }
  }
  return false;
}

const MIN_NET_FRACTION = 0.01; // a mint counts as SOLD only if net-out exceeds 1% of its gross out

/**
 * Parse a SWAP into a clean token→SOL sell, or null if not cleanly attributable. Everything is NET of
 * same-account round-trips: (1) the SOLD mint is the single non-SOL mint with a real NET outflow —
 * intermediates a Jupiter route transits through the wallet's own ATA (e.g. USDC: received then sent
 * onward, out≈back) net to ~0 and are excluded, so such routes aren't wrongly dropped as "batched";
 * (2) the token amount is its net out−back; (3) SOL proceeds are net WSOL in−out (else net native),
 * which strips routing/fee WSOL hops (validated to the lamport against nativeBalanceChange). Returns
 * null for a genuine multi-token sell (2+ mints with real net outflow → unattributable) or no SOL in.
 */
export function parseSwapSell(tx: EnhancedTx, wallet: string): ResidualSell | null {
  const tts = tx.tokenTransfers ?? [];
  const candidates = [
    ...new Set(
      tts
        .filter((t) => t.mint !== SOL_MINT && t.fromUserAccount === wallet && t.tokenAmount > 0)
        .map((t) => t.mint),
    ),
  ];
  const netOut = (mint: string) => {
    const out = tts
      .filter((t) => t.mint === mint && t.fromUserAccount === wallet)
      .reduce((s, t) => s + t.tokenAmount, 0);
    const back = tts
      .filter((t) => t.mint === mint && t.toUserAccount === wallet)
      .reduce((s, t) => s + t.tokenAmount, 0);
    return { out, net: out - back };
  };
  // Keep only mints genuinely SOLD (net outflow), dropping pass-through intermediates (net ≈ 0).
  const sold = candidates
    .map((mint) => ({ mint, ...netOut(mint) }))
    .filter((x) => x.net > 0 && x.net > x.out * MIN_NET_FRACTION);
  if (sold.length !== 1) return null; // 0 = pure transit; 2+ = real batched sell → unattributable
  const { mint, net: tokenAmount } = sold[0]!;

  // NET SOL proceeds — a multi-hop route makes the wallet's WSOL ATA both receive and send WSOL.
  const wsolIn = tts
    .filter((t) => t.mint === SOL_MINT && t.toUserAccount === wallet)
    .reduce((s, t) => s + t.tokenAmount, 0);
  const wsolOut = tts
    .filter((t) => t.mint === SOL_MINT && t.fromUserAccount === wallet)
    .reduce((s, t) => s + t.tokenAmount, 0);
  const netWsol = wsolIn - wsolOut;
  const nat = tx.nativeTransfers ?? [];
  const nativeIn = nat.filter((t) => t.toUserAccount === wallet).reduce((s, t) => s + t.amount, 0);
  const nativeOut = nat
    .filter((t) => t.fromUserAccount === wallet)
    .reduce((s, t) => s + t.amount, 0);
  const netNative = (nativeIn - nativeOut) / LAMPORTS_PER_SOL;
  const solReceived = netWsol > 1e-9 ? netWsol : netNative;
  if (tokenAmount <= 0 || solReceived <= 0) return null;
  return { ts: tx.timestamp, mint, tokenAmount, solReceived };
}

/**
 * Mirror of parseSwapSell for BUYS: the wallet RECEIVES a token (net inflow) and SPENDS SOL. Returns
 * the ResidualSell shape with solReceived = SOL SPENT, so reconstructRealized can FIFO-attribute buys
 * to a position's deposited tokens exactly like it attributes sells to residuals — i.e. the real SOL
 * entry cost of pre-bought deposited tokens (the missing piece for token/mixed-deposit positions).
 */
export function parseSwapBuy(tx: EnhancedTx, wallet: string): ResidualSell | null {
  const tts = tx.tokenTransfers ?? [];
  const candidates = [
    ...new Set(
      tts
        .filter((t) => t.mint !== SOL_MINT && t.toUserAccount === wallet && t.tokenAmount > 0)
        .map((t) => t.mint),
    ),
  ];
  const netIn = (mint: string) => {
    const inn = tts
      .filter((t) => t.mint === mint && t.toUserAccount === wallet)
      .reduce((s, t) => s + t.tokenAmount, 0);
    const back = tts
      .filter((t) => t.mint === mint && t.fromUserAccount === wallet)
      .reduce((s, t) => s + t.tokenAmount, 0);
    return { inn, net: inn - back };
  };
  const bought = candidates
    .map((mint) => ({ mint, ...netIn(mint) }))
    .filter((x) => x.net > 0 && x.net > x.inn * MIN_NET_FRACTION);
  if (bought.length !== 1) return null;
  const { mint, net: tokenAmount } = bought[0]!;

  const wsolOut = tts
    .filter((t) => t.mint === SOL_MINT && t.fromUserAccount === wallet)
    .reduce((s, t) => s + t.tokenAmount, 0);
  const wsolIn = tts
    .filter((t) => t.mint === SOL_MINT && t.toUserAccount === wallet)
    .reduce((s, t) => s + t.tokenAmount, 0);
  const netWsolOut = wsolOut - wsolIn;
  const nat = tx.nativeTransfers ?? [];
  const nativeOut = nat
    .filter((t) => t.fromUserAccount === wallet)
    .reduce((s, t) => s + t.amount, 0);
  const nativeIn = nat.filter((t) => t.toUserAccount === wallet).reduce((s, t) => s + t.amount, 0);
  const netNativeOut = (nativeOut - nativeIn) / LAMPORTS_PER_SOL;
  const solSpent = netWsolOut > 1e-9 ? netWsolOut : netNativeOut;
  if (tokenAmount <= 0 || solSpent <= 0) return null;
  return { ts: tx.timestamp, mint, tokenAmount, solReceived: solSpent };
}
