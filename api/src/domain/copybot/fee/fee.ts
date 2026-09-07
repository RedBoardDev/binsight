/**
 * Copy-bot · Inc.4d — performance-fee arithmetic (PURE: no I/O, no SDK, no DB).
 *
 * SPEC §9: 5% of the POSITIVE realized per-position PnL, levied at close. Per position, no loss offset (a losing
 * position pays nothing) and no high-water mark. The base is the bot's OWN execution ledger — lamport-exact, with
 * NO dependency on the stats engine. Everything here is bigint so the floor is lamport-exact (no float drift).
 */

/** The performance fee in basis points — 500 bps = 5% (SPEC §9, armed from launch). */
export const FEE_BPS = 500;

/** Basis-points denominator: `fee = floor(base × FEE_BPS / FEE_BPS_DENOMINATOR)` (500 / 10 000 = 5%). */
export const FEE_BPS_DENOMINATOR = 10_000;

/**
 * The fee owed on a per-position realized base, in lamports. A base ≤ 0 (a losing OR flat position) pays NOTHING
 * — no loss offset, no high-water mark (SPEC §9). Positive: `floor(base × feeBps / 10000)`, computed in bigint so
 * the floor is lamport-exact regardless of magnitude. Pure.
 */
export function computeFee(baseLamports: bigint, feeBps: number = FEE_BPS): bigint {
  if (baseLamports <= 0n) return 0n; // losers/flat pay nothing (per-position, no offset)
  // bigint division truncates toward zero; base > 0 ⇒ that is exactly floor → the lamport-exact fee.
  return (baseLamports * BigInt(feeBps)) / BigInt(FEE_BPS_DENOMINATOR);
}
