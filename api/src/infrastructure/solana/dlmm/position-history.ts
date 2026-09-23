import type { PositionEvent, PositionHistory } from '@binsight/shared';
import {
  DLMM_PROGRAM_ID,
  decodeLbPair,
  discriminatorOf,
  LBPAIR_DISC,
  positionKindOfDisc,
} from '@binsight/solana-core';
import type {
  Connection,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';

const DLMM = DLMM_PROGRAM_ID;
const SIG_PAGE = 1000;
const MAX_PAGES = 20;
const TOKEN_PROGRAMS = new Set(['spl-token', 'spl-token-2022']);

const isDlmm = (ix: { programId: PublicKey }): boolean => ix.programId.toBase58() === DLMM;
const discMatches = (b: Uint8Array, d: readonly number[]): boolean => d.every((v, i) => b[i] === v);

type Pool = { tokenXMint: string; tokenYMint: string; decX: number; decY: number };

/**
 * A position's event timeline (open / deposit / withdraw / claim / close) from its on-chain transaction
 * history. Works for closed positions too (the account may be gone, its transactions and the lb_pair
 * persist). Failed transactions changed nothing and are skipped — one failed close attempt used to show
 * as a real close. Null when the address has no history.
 */
export async function fetchPositionHistory(
  conn: Connection,
  decimalsOf: (mint: string) => Promise<number>,
  positionAddress: string,
): Promise<PositionHistory | null> {
  const signatures = await allSignatures(conn, new PublicKey(positionAddress));
  if (signatures.length === 0) return null;

  let pool: Pool | null = null;
  const events: PositionEvent[] = [];

  for (const sig of signatures) {
    const tx = await conn.getParsedTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx || tx.meta?.err != null) continue;
    const at = (tx.blockTime ?? 0) * 1000;
    const top = tx.transaction.message.instructions;

    for (let i = 0; i < top.length; i++) {
      const ix = top[i]!;
      if (!isDlmm(ix) || !('data' in ix)) continue;
      const kind = kindOf(ix);
      if (!kind) continue;

      pool ??= await resolvePool(conn, decimalsOf, ix);
      if (!pool) continue;

      let amountX = 0;
      let amountY = 0;
      for (const t of transfersForInstruction(tx, i)) {
        if (t.mint === pool.tokenXMint) amountX += Number(t.amount) / 10 ** pool.decX;
        else if (t.mint === pool.tokenYMint) amountY += Number(t.amount) / 10 ** pool.decY;
      }
      events.push({ kind, at, signature: sig, amountX, amountY });
    }
  }

  if (!pool) return null;
  return { positionAddress, tokenXMint: pool.tokenXMint, tokenYMint: pool.tokenYMint, events };
}

function kindOf(ix: PartiallyDecodedInstruction) {
  try {
    return positionKindOfDisc(discriminatorOf(ix));
  } catch {
    return null; // not base58 / too short
  }
}

/** Every successful signature touching the position account, oldest → newest. */
async function allSignatures(conn: Connection, pk: PublicKey): Promise<string[]> {
  const out: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await conn.getSignaturesForAddress(pk, { before, limit: SIG_PAGE }, 'confirmed');
    if (batch.length === 0) break;
    for (const s of batch) if (s.err == null) out.push(s.signature);
    before = batch[batch.length - 1]!.signature;
    if (batch.length < SIG_PAGE) break;
  }
  return out.reverse();
}

/** Find the lb_pair among the instruction's accounts (by discriminator) and decode its mints. */
async function resolvePool(
  conn: Connection,
  decimalsOf: (mint: string) => Promise<number>,
  ix: PartiallyDecodedInstruction,
): Promise<Pool | null> {
  const infos = await conn.getMultipleAccountsInfo(ix.accounts, 'confirmed');
  const lbPair = infos.find((info) => info && discMatches(info.data, LBPAIR_DISC));
  if (!lbPair) return null;
  const { tokenXMint, tokenYMint } = decodeLbPair(lbPair.data);
  const [decX, decY] = await Promise.all([
    decimalsOf(tokenXMint.toBase58()),
    decimalsOf(tokenYMint.toBase58()),
  ]);
  return { tokenXMint: tokenXMint.toBase58(), tokenYMint: tokenYMint.toBase58(), decX, decY };
}

/** Token transfers (classic SPL and Token-2022) nested under the top-level instruction at `index`. */
function transfersForInstruction(
  tx: ParsedTransactionWithMeta,
  index: number,
): Array<{ amount: string; mint?: string }> {
  const out: Array<{ amount: string; mint?: string }> = [];
  for (const grp of tx.meta?.innerInstructions ?? []) {
    if (grp.index !== index) continue;
    for (const ix of grp.instructions) {
      if (!('parsed' in ix) || !TOKEN_PROGRAMS.has(ix.program)) continue;
      const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
      if (p.type !== 'transfer' && p.type !== 'transferChecked') continue;
      const info = p.info ?? {};
      const amount =
        (info.amount as string) ?? (info.tokenAmount as { amount?: string })?.amount ?? '0';
      out.push({ amount, mint: info.mint as string | undefined });
    }
  }
  return out;
}
