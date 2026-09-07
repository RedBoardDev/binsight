/**
 * Copy-bot · Inc.4d — fee arithmetic invariants (SPEC §9). These encode the WHY, not just the WHAT:
 *  - a WINNER pays exactly floor(5%) — the fee is real revenue, so an off-by-one lamport is a real error;
 *  - a LOSER/flat position pays NOTHING (per-position, no loss offset, no high-water mark) — over-charging a
 *    losing position would silently take a user's capital, the cardinal trust violation;
 *  - the floor is lamport-EXACT at any magnitude (bigint, no float drift) — the coffre transfers this to the cent.
 */
import { describe, expect, it } from 'vitest';
import { computeFee, FEE_BPS, FEE_BPS_DENOMINATOR } from './fee';

describe('computeFee (SPEC §9 — 5% of positive realized, per position)', () => {
  it('a positive base pays exactly floor(5%)', () => {
    // 1 SOL profit → 0.05 SOL fee, to the lamport.
    expect(computeFee(1_000_000_000n)).toBe(50_000_000n);
    expect(computeFee(200_000_000n)).toBe(10_000_000n);
  });

  it('a losing position pays nothing (no loss offset)', () => {
    expect(computeFee(-1n)).toBe(0n);
    expect(computeFee(-5_000_000_000n)).toBe(0n);
  });

  it('a flat (zero) position pays nothing', () => {
    expect(computeFee(0n)).toBe(0n);
  });

  it('floors to the lamport — never rounds up (a non-divisible base)', () => {
    // 20001 lamports × 500 / 10000 = 1000.05 → floored to 1000, never 1001.
    expect(computeFee(20_001n)).toBe(1000n);
    // 19 lamports × 5% = 0.95 → 0 (a sub-lamport fee is not owed).
    expect(computeFee(19n)).toBe(0n);
  });

  it('is exact at large magnitude (bigint, no float drift)', () => {
    // 100 SOL base — well beyond a float-safe intermediate if computed as base×500 in a double.
    expect(computeFee(100_000_000_000n)).toBe(5_000_000_000n);
  });

  it('the constants pin the 5% rate', () => {
    expect(FEE_BPS).toBe(500);
    expect(FEE_BPS_DENOMINATOR).toBe(10_000);
    expect(FEE_BPS / FEE_BPS_DENOMINATOR).toBe(0.05);
  });
});
