import { createHash } from 'node:crypto';
import { DLMM_PROGRAM_ID, type PositionEventKind } from '@binsight/shared';
import { utils } from '@coral-xyz/anchor';
import type {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
} from '@solana/web3.js';

/**
 * The single source of truth for "which DLMM instruction is this?".
 *
 * The DLMM program is an Anchor program, so `getParsedTransaction` hands its instructions back
 * undecoded (base58 `data`); the first 8 bytes are the Anchor discriminator, sha256("global:<name>").
 * Mapping those bytes to an instruction kind is what lets us tell the two fundamentally different
 * reasons the DLMM program appears in a transaction apart:
 *
 *  - POSITION lifecycle (open / deposit / withdraw / claim / close) — the wallet acting on ITS OWN
 *    liquidity. The token movements are position legs, already captured in `dlmm_legs`.
 *  - `swap` — the wallet (or an aggregator routing on its behalf) trading AGAINST a DLMM pool. This
 *    is an ordinary market swap that happens to clear on Meteora.
 *
 * Conflating the two is a data-integrity bug in both directions: treating a routed swap as position
 * activity DROPS a real sale from the realized-PnL inputs, while treating a withdraw as a swap
 * FABRICATES a near-zero cost basis. Both were observed on real transactions before this split.
 *
 * Discriminators are derived deterministically and were validated byte-exact against real on-chain
 * transactions + the datapi aggregates.
 */

/** Anchor instruction discriminator = sha256("global:<snake_name>")[:8], hex. */
const disc = (name: string): string =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');

const KIND_BY_DISC = new Map<string, PositionEventKind>();
const define = (kind: PositionEventKind, names: string[]): void => {
  for (const n of names) KIND_BY_DISC.set(disc(n), kind);
};
define('open', [
  'initialize_position',
  'initialize_position_pda',
  'initialize_position_by_operator',
]);
define('deposit', [
  'add_liquidity',
  'add_liquidity_by_weight',
  'add_liquidity_by_strategy',
  'add_liquidity_by_strategy_one_side',
  'add_liquidity_one_side_precise',
  'add_liquidity2',
  'add_liquidity_by_strategy2',
  'add_liquidity_one_side_precise2',
]);
define('withdraw', [
  'remove_liquidity',
  'remove_liquidity_by_range',
  'remove_liquidity2',
  'remove_liquidity_by_range2',
  'remove_all_liquidity',
]);
define('claim', ['claim_fee', 'claim_fee2']);
define('close', ['close_position', 'close_position2', 'close_position_if_empty']);

/** Position-lifecycle kind for an instruction discriminator, or null (swap / event-CPI / unknown). */
export function positionKindOfDisc(discriminator: string): PositionEventKind | null {
  return KIND_BY_DISC.get(discriminator) ?? null;
}

/** First 8 bytes of a partially-decoded instruction's data, hex — the Anchor discriminator. */
export function discriminatorOf(ix: PartiallyDecodedInstruction): string {
  return Buffer.from(utils.bytes.bs58.decode(ix.data)).subarray(0, 8).toString('hex');
}

type AnyIx = ParsedInstruction | PartiallyDecodedInstruction;

/** Every instruction of a tx: top-level message instructions + all inner (CPI) instructions. */
function allInstructions(tx: ParsedTransactionWithMeta): AnyIx[] {
  return [
    ...(tx?.transaction?.message?.instructions ?? []),
    ...(tx?.meta?.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
}

/**
 * Does this transaction act on one of the wallet's DLMM POSITIONS (open/deposit/withdraw/claim/close)?
 *
 * False for a transaction whose only DLMM instruction is a `swap` — an aggregator routing a trade
 * through a Meteora pool. That case is a genuine market swap and must stay visible to the swap
 * extraction, which is why mere program presence is NOT a usable signal here.
 *
 * Malformed/non-base58 instruction data is ignored rather than thrown on: an undecodable instruction
 * tells us nothing, and this predicate must never break an ingest.
 */
export function hasDlmmPositionInstruction(tx: ParsedTransactionWithMeta): boolean {
  for (const ix of allInstructions(tx)) {
    if (ix.programId?.toString() !== DLMM_PROGRAM_ID) continue;
    const data = (ix as PartiallyDecodedInstruction).data;
    if (typeof data !== 'string') continue;
    try {
      if (positionKindOfDisc(discriminatorOf(ix as PartiallyDecodedInstruction)) != null)
        return true;
    } catch {
      // not base58 / too short — not a recognisable position instruction
    }
  }
  return false;
}
