import { describe, expect, it } from 'vitest';
import {
  WITHDRAW_RESERVE_LAMPORTS,
  WITHDRAW_RESERVE_SOL,
  withdrawableLamports,
} from './withdrawable';

const SOL = 1_000_000_000;

describe('withdrawableLamports — free = balance − deployed − reserve (SPEC §2.2)', () => {
  it('subtracts BOTH the deployed capital and the reserve from the balance', () => {
    // 2 SOL balance, 0.5 SOL deployed, 0.05 SOL reserve → 1.45 SOL free.
    expect(
      withdrawableLamports({
        balanceLamports: 2 * SOL,
        deployedLamports: 0.5 * SOL,
        reserveLamports: WITHDRAW_RESERVE_LAMPORTS,
      }),
    ).toBe(1.45 * SOL);
  });

  it('floors at 0 — never offers a negative amount when deployed + reserve exceed the balance', () => {
    expect(
      withdrawableLamports({
        balanceLamports: 0.03 * SOL,
        deployedLamports: 0,
        reserveLamports: WITHDRAW_RESERVE_LAMPORTS,
      }),
    ).toBe(0);
  });

  it('with nothing deployed, free = balance − reserve', () => {
    expect(
      withdrawableLamports({
        balanceLamports: 1 * SOL,
        deployedLamports: 0,
        reserveLamports: WITHDRAW_RESERVE_LAMPORTS,
      }),
    ).toBe(0.95 * SOL);
  });

  it('the reserve is the documented 0.05 SOL', () => {
    expect(WITHDRAW_RESERVE_SOL).toBe(0.05);
    expect(WITHDRAW_RESERVE_LAMPORTS).toBe(50_000_000);
  });
});
