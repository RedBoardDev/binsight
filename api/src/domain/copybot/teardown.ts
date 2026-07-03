/**
 * Copy-bot · Inc.4e — the account-teardown GATE (PURE, no I/O). Account deletion IRREVERSIBLY soft-detaches the
 * Privy wallet (SPEC §2.4 / #56), so the SYSTEM must refuse to delete an account that still holds funds or open
 * mirrors UNLESS the user has provably taken custody of what remains — a completed withdrawal (Path B) OR a confirmed
 * key-export acknowledgment. Isolating the decision as a pure predicate lets the fund-safety gate be exhaustively
 * unit-tested (global Rule 8); the teardown SERVICE only orchestrates the I/O around this verdict, and the ordered
 * teardown ALSO force-closes + re-confirms no open mirrors before the delete (this gate is the ENTRY guard, that
 * confirmation the never-miss backstop).
 */

/** Lamports per SOL (local per-module const — the project convention, see activation.ts / sizing.ts). */
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Dust threshold (SPEC §2.4): a wallet holding ≤ this much SOL is "empty enough" to delete without a withdrawal.
 *  0.05 SOL mirrors the sizing `solReserveSol` floor — below it nothing meaningful is left to rescue. */
export const DUST_SOL = 0.05;
export const DUST_LAMPORTS = DUST_SOL * LAMPORTS_PER_SOL;

/** Why the teardown gate refused (typed → the route maps it to a 409 body the UI renders). */
export type TeardownRefusal = 'open_mirrors' | 'funds_remain';

export interface TeardownGateInput {
  /** How many of the user's mirrors are still OPEN (funds are locked in positions until they force-close). */
  openMirrorCount: number;
  /** The wallet's live idle SOL balance in lamports. */
  balanceLamports: number;
  /** The user completed a withdrawal (withdrawal_ack_at set) — they took custody of the funds. */
  withdrawalAck: boolean;
  /** The user acknowledged the key export (export_ack_at set) — they can recover the wallet themselves. */
  exportAck: boolean;
  /** Dust ceiling (DUST_LAMPORTS); injected so the threshold is explicit + independently testable. */
  dustLamports: number;
}

export type TeardownGate = { ok: true } | { ok: false; reason: TeardownRefusal };

/**
 * Decide whether an account MAY be torn down. A completed withdrawal OR a confirmed key-export ack is the user
 * taking custody of whatever remains — it lifts BOTH fund guards (SPEC §2.4: refuse "…without a completed withdrawal
 * or a confirmed key-export acknowledgment"). Absent an ack: refuse while open mirrors exist (capital locked in
 * positions) or the wallet still holds more than dust. Pure; every branch is a unit-tested refusal/pass case.
 */
export function canTeardown(input: TeardownGateInput): TeardownGate {
  const acknowledged = input.withdrawalAck || input.exportAck;
  if (acknowledged) return { ok: true };
  if (input.openMirrorCount > 0) return { ok: false, reason: 'open_mirrors' };
  if (input.balanceLamports > input.dustLamports) return { ok: false, reason: 'funds_remain' };
  return { ok: true };
}
