/**
 * Copy-bot · BRAIN — ComputeBudget tx helpers (web3.js). Set the compute-unit LIMIT (CU cap) and the compute-unit
 * PRICE (priority fee) on a built DLMM tx before it is serialized for the vault. Pure tx mutation (no I/O, no RPC).
 * Wall B allowlists the ComputeBudget program, so the vault lands these unchanged.
 */
import { ComputeBudgetProgram, type Transaction } from '@solana/web3.js';
import {
  computeUnitPriceMicroLamports,
  type PriorityFeeConfig,
} from '@/domain/copybot/priority-fee';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const CB_SET_UNIT_LIMIT = 2; // ComputeBudget instruction discriminator (SetComputeUnitLimit)
const CB_SET_UNIT_PRICE = 3; // ComputeBudget instruction discriminator (SetComputeUnitPrice)
// Fallback CU limit for capping the price when a tx carries NO explicit SetComputeUnitLimit ix. Set to Solana's
// MAX_COMPUTE_UNIT_LIMIT (1.4M CU): without a limit ix the runtime lets the tx burn up to that per-tx ceiling, so
// pricing the fee against it guarantees priorityFee = price × actualCU can never exceed maxCapSol. The old 200k
// (the per-INSTRUCTION default) understated the worst case — a multi-ix tx consuming the full 1.4M could blow the
// cap by up to ~7× (1.4M / 200k).
const DEFAULT_CU_LIMIT_FOR_PRICE = 1_400_000;

const firstTx = (t: Transaction | Transaction[]): Transaction => {
  if (!Array.isArray(t)) return t;
  // Assert a single tx instead of silently truncating to [0]: an empty array would crash downstream on
  // `.instructions`, and a multi-tx array would silently drop txs — both are caller bugs surfaced loudly here (the
  // SDK builders this wraps yield exactly one tx per call).
  if (t.length !== 1) {
    throw new Error(`compute-budget: expected exactly one transaction, got ${t.length}`);
  }
  return t[0] as Transaction;
};
const isCbIx = (ix: { programId: { toBase58(): string }; data: Buffer }, disc: number): boolean =>
  ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === disc;

/** Force an explicit CU limit (the SDK's estimate fails when a token isn't held yet). Replaces any existing limit ix. */
export function withCuLimit(t: Transaction | Transaction[], units: number): Transaction {
  const tx = firstTx(t);
  tx.instructions = tx.instructions.filter((ix) => !isCbIx(ix, CB_SET_UNIT_LIMIT));
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  return tx;
}

const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;

/**
 * Set the priority fee (compute-unit price) on a tx, bounded by the leader's capped tier. Reads the tx's CU limit
 * (the worst case) so `price × cuLimit` never exceeds the cap. An optional live µLamports/CU estimate (from the fee
 * oracle) can raise the tier's static target during congestion; the cap still wins. Replaces any existing price ix
 * (idempotent). Returns the priority lamports this fee will cost at the worst case — used to size the Jito tip
 * within the shared cap.
 */
export function applyPriorityFee(
  tx: Transaction,
  pf: PriorityFeeConfig,
  liveMicroPerCu: number | null = null,
): number {
  const limitIx = tx.instructions.find((ix) => isCbIx(ix, CB_SET_UNIT_LIMIT));
  const cuLimit = limitIx ? limitIx.data.readUInt32LE(1) : DEFAULT_CU_LIMIT_FOR_PRICE;
  const micro = computeUnitPriceMicroLamports(pf.tier, cuLimit, pf.maxCapSol, liveMicroPerCu);
  tx.instructions = tx.instructions.filter((ix) => !isCbIx(ix, CB_SET_UNIT_PRICE));
  if (micro > 0)
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
  return Math.floor((micro * cuLimit) / MICRO_LAMPORTS_PER_LAMPORT);
}
