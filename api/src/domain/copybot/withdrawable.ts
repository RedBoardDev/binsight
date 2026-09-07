/**
 * Copy-bot · Inc.4e — the withdrawable-balance helper (PURE). The withdraw UI (Path B, SPEC §2.2) caps the amount to
 * the FREE SOL so a user can never drain the reserve the bot keeps for fees/rent, nor the capital committed to open
 * mirrors. A pure function so the cap math is unit-tested; the client-side confirmation stays the only real barrier
 * (XSS residual accepted, SPEC §17.1) — this cap is a UX guardrail, not the fund-safety control.
 */

/** Lamports per SOL (local per-module const — the project convention). */
const LAMPORTS_PER_SOL = 1_000_000_000;

/** SOL the bot always keeps back (mirrors the sizing `solReserveSol` default, SPEC §5) — never offered for withdrawal. */
export const WITHDRAW_RESERVE_SOL = 0.05;
export const WITHDRAW_RESERVE_LAMPORTS = WITHDRAW_RESERVE_SOL * LAMPORTS_PER_SOL;

export interface WithdrawableInput {
  /** The wallet's live idle SOL (getBalance), in lamports. */
  balanceLamports: number;
  /** SOL committed to open mirrors (conservatively excluded from the offered amount), in lamports. */
  deployedLamports: number;
  /** The kept-back reserve (WITHDRAW_RESERVE_LAMPORTS), in lamports. */
  reserveLamports: number;
}

/**
 * Free, withdrawable lamports = balance − deployed − reserve, floored at 0 (never negative). Conservative by design:
 * both the reserve and the deployed capital are withheld so an offered withdrawal can never starve the bot's fee/rent
 * budget or drain SOL the bot is still managing.
 */
export function withdrawableLamports(input: WithdrawableInput): number {
  return Math.max(0, input.balanceLamports - input.deployedLamports - input.reserveLamports);
}
