import { utils } from '@coral-xyz/anchor';
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from '@solana/web3.js';
import { DLMM_PROGRAM_ID } from '../constants';
import type { DlmmLeg } from '../types';
import { dlmmCoder } from './coder';

const bs58 = utils.bytes.bs58;

/**
 * Decodes Meteora DLMM liquidity events from a transaction PURELY from the on-chain Anchor events,
 * driven by the OFFICIAL program IDL (no hand-rolled byte offsets, no Meteora off-chain API).
 *
 * Meteora emits its events via Event CPI (`emit_cpi!`): each event is a self-invocation of the DLMM
 * program carried as an INNER instruction whose data is `[8-byte event-cpi tag][8-byte event disc]
 * [borsh event]`. We read them from `meta.innerInstructions` (NOT `logMessages`, which Solana
 * truncates at 10 KB and silently drops). The 8-byte tag is stripped and the rest handed to Anchor's
 * IDL-driven event coder — so every present and future event variant decodes by name automatically.
 */

const num = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  // anchor decodes u64 as BN
  if (v && typeof (v as { toString: () => string }).toString === 'function')
    return BigInt((v as { toString: () => string }).toString());
  return 0n;
};
const binOf = (data: Record<string, unknown>): number | null => {
  const b = data.active_bin_id ?? data.active_id ?? data.bin_id;
  return b == null ? null : Number(b);
};
/** Identity of a single claim: the same pool/position/X/Y is the SAME claim, whatever event emitted it. */
const claimKey = (data: Record<string, unknown>): string =>
  [
    String(data.lb_pair ?? ''),
    String(data.position ?? ''),
    num(data.fee_x).toString(),
    num(data.fee_y).toString(),
  ].join(':');

/** A raw decoded DLMM event with its host signature/blockTime (before normalization into legs). */
interface RawEvent {
  name: string;
  data: Record<string, unknown>;
  signature: string;
  blockTime: number | null;
}

/** Decode every DLMM Anchor event from a parsed transaction's inner instructions. */
function rawEvents(tx: ParsedTransactionWithMeta): RawEvent[] {
  const out: RawEvent[] = [];
  const signature = tx.transaction.signatures[0] ?? '';
  const blockTime = tx.blockTime ?? null;
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const pid = 'programId' in ix ? (ix.programId?.toString() ?? '') : '';
      if (pid !== DLMM_PROGRAM_ID) continue;
      const dataB58 = (ix as PartiallyDecodedInstruction).data;
      if (!dataB58) continue;
      let buf: Buffer;
      try {
        buf = Buffer.from(bs58.decode(dataB58));
      } catch {
        continue;
      }
      if (buf.length < 16) continue; // need the 8-byte self-CPI tag + 8-byte event disc
      // strip the self-CPI tag; Anchor's event coder reads the 8-byte event disc + borsh payload.
      const evB64 = Buffer.from(buf.subarray(8)).toString('base64');
      let ev: { name: string; data: Record<string, unknown> } | null;
      try {
        ev = dlmmCoder.events.decode(evB64);
      } catch {
        continue;
      }
      if (ev) out.push({ name: ev.name, data: ev.data, signature, blockTime });
    }
  }
  return out;
}

/**
 * Normalize a transaction's DLMM events into deposit/withdraw/claim legs.
 *
 * - AddLiquidity → one deposit leg (amounts[0]=X, amounts[1]=Y).
 * - RemoveLiquidity → one withdraw leg.
 * - Rebalancing → a withdraw leg (x/y_withdrawn) + a deposit leg (x/y_added) — it pulls liquidity
 *   from old bins and re-adds to new bins; Meteora counts both, so we do too.
 * - ClaimFee2 → one claim leg (fee_x, fee_y) at its own active bin.
 * - ClaimFee (v1) → claim leg. If no sibling event supplies a bin, the exact X/Y quantities are kept
 *   with a null price anchor; valuation then preserves the quote-side amount and marks the rest partial.
 */
export function decodeDlmmLegs(tx: ParsedTransactionWithMeta): DlmmLeg[] {
  const events = rawEvents(tx);
  if (events.length === 0) return [];
  // a representative bin id for the tx, to backfill events that don't carry one (ClaimFee v1).
  const txBin = events.map((e) => binOf(e.data)).find((b) => b != null) ?? null;
  // ClaimFee (v1) and ClaimFee2 may be emitted together for the SAME claim (v2 just added the bin id) —
  // count only one. Deduplicate by the exact pool/position/X/Y identity, NOT by transaction-wide presence:
  // a batch can carry several claims, and only some of them may have a ClaimFee2 sibling. Keying on
  // presence dropped every v1 claim in such a tx, silently losing the ones with no v2 counterpart.
  const modernClaims = new Set(
    events.filter((e) => e.name === 'ClaimFee2').map((e) => claimKey(e.data)),
  );
  const seenClaims = new Set<string>();
  const legs: DlmmLeg[] = [];
  for (const e of events) {
    const d = e.data;
    if (e.name === 'ClaimFee' && modernClaims.has(claimKey(d))) continue;
    const base = {
      signature: e.signature,
      blockTime: e.blockTime,
      position: String(d.position ?? ''),
      lbPair: String(d.lb_pair ?? ''),
    };
    const bin = binOf(d) ?? txBin;

    switch (e.name) {
      case 'AddLiquidity': {
        if (bin == null) break; // liquidity legs mix both sides → unvaluable without a price anchor
        const a = d.amounts as unknown[];
        legs.push({
          ...base,
          kind: 'deposit',
          activeBinId: bin,
          amountX: num(a?.[0]),
          amountY: num(a?.[1]),
        });
        break;
      }
      case 'RemoveLiquidity': {
        if (bin == null) break;
        const a = d.amounts as unknown[];
        legs.push({
          ...base,
          kind: 'withdraw',
          activeBinId: bin,
          amountX: num(a?.[0]),
          amountY: num(a?.[1]),
        });
        break;
      }
      case 'Rebalancing': {
        if (bin == null) break;
        const xWd = num(d.x_withdrawn_amount),
          yWd = num(d.y_withdrawn_amount);
        const xAdd = num(d.x_added_amount),
          yAdd = num(d.y_added_amount);
        if (xWd > 0n || yWd > 0n)
          legs.push({ ...base, kind: 'withdraw', activeBinId: bin, amountX: xWd, amountY: yWd });
        if (xAdd > 0n || yAdd > 0n)
          legs.push({ ...base, kind: 'deposit', activeBinId: bin, amountX: xAdd, amountY: yAdd });
        break;
      }
      case 'ClaimFee2':
      case 'ClaimFee': {
        const key = claimKey(d);
        if (seenClaims.has(key)) break;
        seenClaims.add(key);
        legs.push({
          ...base,
          kind: 'claim',
          activeBinId: bin,
          amountX: num(d.fee_x),
          amountY: num(d.fee_y),
        });
        break;
      }
      default:
        break; // PositionCreate/Close, CompositionFee, rewards, swaps — not capital legs
    }
  }
  return legs;
}
