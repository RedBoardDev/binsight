import { ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { computeUnitPriceMicroLamports } from '@/domain/copybot/priority-fee';
import { applyPriorityFee, COMPUTE_BUDGET_PROGRAM, withCuLimit } from './compute-budget';

const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;
const txWithLimit = (units: number): Transaction =>
  new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
const find = (tx: Transaction, disc: number) =>
  tx.instructions.find(
    (ix) => ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === disc,
  );
const priceOf = (tx: Transaction): bigint | null => {
  const ix = find(tx, CB_SET_UNIT_PRICE);
  return ix ? ix.data.readBigUInt64LE(1) : null;
};

describe('compute-budget · withCuLimit', () => {
  it('sets the CU limit and replaces any existing one (exactly one limit ix)', () => {
    const tx = txWithLimit(200_000);
    withCuLimit(tx, 1_400_000);
    const limits = tx.instructions.filter(
      (ix) =>
        ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === CB_SET_UNIT_LIMIT,
    );
    expect(limits).toHaveLength(1);
    expect(limits[0]!.data.readUInt32LE(1)).toBe(1_400_000);
  });

  it('accepts a single-element array (the SDK array form) and sets the limit on that tx', () => {
    const tx = txWithLimit(200_000);
    const out = withCuLimit([tx], 1_400_000);
    expect(out).toBe(tx);
    expect(find(out, CB_SET_UNIT_LIMIT)!.data.readUInt32LE(1)).toBe(1_400_000);
  });

  it('throws on an empty tx array instead of crashing on undefined (idx19: fail loud, no silent truncation)', () => {
    expect(() => withCuLimit([], 1_400_000)).toThrow(/exactly one transaction/);
  });

  it('throws on a multi-tx array instead of silently dropping txs (idx19)', () => {
    // WHY (idx19): truncating [tx0, tx1] to tx0 would drop a tx the caller built — a silent, money-critical loss.
    expect(() => withCuLimit([txWithLimit(200_000), txWithLimit(300_000)], 1_400_000)).toThrow(
      /exactly one transaction/,
    );
  });
});

describe('compute-budget · applyPriorityFee', () => {
  it('adds a CU-price ix at the tier price when the cap is not binding', () => {
    const tx = txWithLimit(200_000);
    applyPriorityFee(tx, { tier: 'medium', maxCapSol: 0.005 });
    expect(priceOf(tx)).toBe(BigInt(computeUnitPriceMicroLamports('medium', 200_000, 0.005)));
  });

  it('respects the cap: price × cuLimit never exceeds maxCapSol (the cap wins on-tx too)', () => {
    // WHY: the on-tx price must honor the same hard cap the pure function computes — a tiny cap clamps the high tier.
    const tx = txWithLimit(1_400_000);
    applyPriorityFee(tx, { tier: 'high', maxCapSol: 0.00005 });
    const price = priceOf(tx)!;
    expect(Number((price * 1_400_000n) / 1_000_000n)).toBeLessThanOrEqual(
      0.00005 * 1_000_000_000 + 1,
    );
  });

  it('is idempotent — re-applying replaces, never stacks, the price ix', () => {
    const tx = txWithLimit(200_000);
    applyPriorityFee(tx, { tier: 'low', maxCapSol: 0.005 });
    applyPriorityFee(tx, { tier: 'high', maxCapSol: 0.005 });
    const prices = tx.instructions.filter(
      (ix) =>
        ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === CB_SET_UNIT_PRICE,
    );
    expect(prices).toHaveLength(1);
    expect(priceOf(tx)).toBe(BigInt(computeUnitPriceMicroLamports('high', 200_000, 0.005))); // the latest tier wins
  });

  it('falls back to the WORST-CASE CU limit (1.4M) for capping when the tx carries no limit ix', () => {
    // WHY (idx20): with no SetComputeUnitLimit ix the runtime lets the tx burn up to Solana's 1.4M CU max, so the
    // price must be capped against 1.4M — not the 200k per-instruction default — or the worst-case fee blows the cap.
    const tx = new Transaction(); // no ComputeBudget limit ix
    applyPriorityFee(tx, { tier: 'medium', maxCapSol: 0.005 });
    expect(priceOf(tx)).toBe(BigInt(computeUnitPriceMicroLamports('medium', 1_400_000, 0.005)));
  });

  it('a no-limit-ix tx cannot blow the cap even if it burns the full 1.4M CU (idx20)', () => {
    // WHY (idx20): the on-chain fee is price × ACTUAL CU. A tx with no limit ix can consume up to MAX_COMPUTE_UNIT_LIMIT,
    // so price × 1.4M must stay within maxCapSol. This FAILS if the fallback assumes only 200k (price ~7× too high).
    const cap = 0.00005;
    const tx = new Transaction(); // no limit ix → runtime allows up to the 1.4M ceiling
    applyPriorityFee(tx, { tier: 'high', maxCapSol: cap });
    const price = priceOf(tx)!;
    const worstCaseFeeLamports = Number((price * 1_400_000n) / 1_000_000n);
    expect(worstCaseFeeLamports).toBeLessThanOrEqual(cap * 1_000_000_000 + 1);
  });

  it('returns the priority lamports it will cost (price × cuLimit / 1e6) — the figure that sizes the Jito tip', () => {
    // WHY: the brain feeds this return into jitoTipFor so priority + tip stay within the SAME cap; a wrong figure
    // would let the tip overspend the cap (or starve it). Must equal the on-tx price × the limit it priced against.
    const tx = txWithLimit(200_000);
    const spent = applyPriorityFee(tx, { tier: 'medium', maxCapSol: 0.005 });
    const micro = computeUnitPriceMicroLamports('medium', 200_000, 0.005);
    expect(spent).toBe(Math.floor((micro * 200_000) / 1_000_000));
  });

  it('the returned spend never exceeds the cap lamports (so the tip headroom is real)', () => {
    const cap = 0.00005;
    const spent = applyPriorityFee(txWithLimit(1_400_000), { tier: 'high', maxCapSol: cap });
    expect(spent).toBeLessThanOrEqual(Math.ceil(cap * 1_000_000_000));
  });
});
