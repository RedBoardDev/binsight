/**
 * Copy-bot · P2.6 — caps + kill-switch (PURE, no I/O). The safety envelope at the WALLET level:
 * gates the OPENING of a new position (≠ filters, which judge the candidate; here we judge the global state).
 *
 * The kill-switch blocks ONLY entries — exits / reconciliation keep running (spec 06 §1.2:
 * protect funds even with the bot off). The clock (`nowMs`) is injected → pure/testable (sliding window).
 *
 * Defaults (spec 06 §1.1, DECISIONS Round 2): maxOpenPositions 8 (P), 10 opens / 10 min (DECIDED),
 * kill-switches OFF, per-token & total exposure OFF (optional). The loss-per-day cap is ABANDONED
 * as a default (never reintroduced as an active guardrail).
 */

export interface CapsConfig {
  killSwitchGlobal: boolean;
  killSwitchLeader: boolean; // pause the current leader (CLI = a single leader)
  maxOpenPositions: number | null;
  maxConcurrentPerToken: number | null; // per token mint; default 1 (#161 fee-attribution safety, see CAPS_DEFAULTS); null = unlimited
  maxOpensPerWindow: number | null;
  windowMinutes: number | null;
  maxTotalExposureSol: number | null; // optional; null = OFF (default)
}

export interface CapsState {
  openPositions: number;
  totalExposureSol: number;
  /** SOL exposure across the CANDIDATE LEADER's open mirrors only (scope of the per-leader exposure cap). */
  leaderExposureSol: number;
  tokenOpenCount: number; // positions open on the candidate's token
  openTimestampsMs: number[]; // wall-clock ms of ALL our opens (checkCaps filters by window)
}

/** The mirror slice the per-leader exposure sum reads (structural: the brain passes its `Mirror` objects). */
export interface LeaderScopedMirror {
  /** wallet address of the leader this mirror copies ('' for a legacy row — matches no real leader). */
  leaderAddress: string;
  sizeSol: number;
}

/** SOL exposure across ONE leader's open mirrors — the `leaderExposureSol` input of `checkCaps` (SPEC §4.2/§12).
 *  Scoped per leader so leader A's open positions never consume leader B's exposure budget. Pure. */
export function exposureFor(mirrors: readonly LeaderScopedMirror[], leader: string): number {
  return mirrors.reduce((s, m) => (m.leaderAddress === leader ? s + m.sizeSol : s), 0);
}

export type CapVerdict = { action: 'allow' } | { action: 'block'; reason: string };
const block = (reason: string): CapVerdict => ({ action: 'block', reason });
const ALLOW: CapVerdict = { action: 'allow' };

/** "Active envelope" defaults (spec 06 §1.1 / Round 2). */
export const CAPS_DEFAULTS: CapsConfig = {
  killSwitchGlobal: false,
  killSwitchLeader: false,
  maxOpenPositions: 8,
  // Default 1 (finding #161): the close-path residual sell reads the WHOLE wallet balance of the mint and books ALL
  // proceeds to the closing position, so two concurrent same-mint positions would commingle — the first to close is
  // over-charged the performance fee (up to 2x) while the second's base floors at 0, and the two do NOT net. Capping
  // concurrency at 1 makes the whole-balance read == that position's OWN token leg, so each fee base counts only its
  // own realized proceeds. `null` (explicit) restores unlimited for a user who accepts the shared-wallet imprecision.
  maxConcurrentPerToken: 1,
  maxOpensPerWindow: 10,
  windowMinutes: 10,
  maxTotalExposureSol: null,
};

/** Allows or blocks a NEW opening of size `sizeSol`. First block wins (kill-switch first). Pure.
 *  `leaderMaxTotalExposureSol` is the PER-LEADER exposure ceiling (SPEC §4.2/§12) resolved from that leader's
 *  settings — checked against `state.leaderExposureSol` (that leader's mirrors only); null = no per-leader cap. */
export function checkCaps(
  cfg: CapsConfig,
  state: CapsState,
  sizeSol: number,
  nowMs: number,
  leaderMaxTotalExposureSol: number | null = null,
): CapVerdict {
  if (cfg.killSwitchGlobal) return block('kill_switch_global');
  if (cfg.killSwitchLeader) return block('kill_switch_leader');
  if (cfg.maxOpenPositions != null && state.openPositions >= cfg.maxOpenPositions) {
    return block('max_open_positions');
  }
  if (cfg.maxConcurrentPerToken != null && state.tokenOpenCount >= cfg.maxConcurrentPerToken) {
    return block('max_concurrent_per_token');
  }
  if (cfg.maxOpensPerWindow != null && cfg.windowMinutes != null) {
    const since = nowMs - cfg.windowMinutes * 60_000;
    const recent = state.openTimestampsMs.filter((t) => t > since).length;
    if (recent >= cfg.maxOpensPerWindow) return block('max_opens_per_window');
  }
  if (
    cfg.maxTotalExposureSol != null &&
    state.totalExposureSol + sizeSol > cfg.maxTotalExposureSol
  ) {
    return block('max_total_exposure');
  }
  if (
    leaderMaxTotalExposureSol != null &&
    state.leaderExposureSol + sizeSol > leaderMaxTotalExposureSol
  ) {
    return block('max_leader_exposure');
  }
  return ALLOW;
}
