/**
 * Copy-bot · STOP = FORCE-CLOSE planning (PURE, no I/O — SPEC §4.3). When a config write flips a leader's
 * `enabled` true→false (or removes the leader), or flips the global `user.enabled` true→false, the CONCERNED open
 * mirrors must be force-closed (config preserved). This planner diffs two OBSERVED configs — the brain calls it
 * with `prev` = the config it was actually running (never a stale/boot value, so a restart can't replay an old
 * stop) — and returns which mirrors to close. It NEVER plans an open: a start transition is a no-op here, which
 * is exactly the forward-only rule (enabling a leader must not copy its already-open positions, SPEC §4.3).
 */
import type { CopybotConfig } from './config';

/** An open mirror as the planner needs it: our/leader position + WHICH leader it copies. */
export interface StopCloseMirror {
  ourPosition: string;
  leaderPosition: string;
  leaderAddress: string;
}

/** Why a mirror is being force-closed (journaled verbatim; resolves to the pinned failsafe code). */
export type StopCloseReason = 'user_stopped' | 'leader_stopped' | 'leader_removed';

export interface StopClosePlan {
  toClose: Array<StopCloseMirror & { reason: StopCloseReason }>;
}

/** True when this leader is STARTED in `cfg`: present AND enabled (absent counts as stopped — SPEC §4.3). */
function isStarted(cfg: CopybotConfig, leaderAddress: string): boolean {
  return cfg.leaders.some((l) => l.address === leaderAddress && l.enabled);
}

/**
 * Diff `prev` → `next` and plan the force-closes for the observed STOP transitions:
 *  - global stop (`user.enabled` true→false) ⇒ close ALL open mirrors;
 *  - per-leader stop (`enabled` true→false, or leader REMOVED from the list) ⇒ close only THAT leader's mirrors.
 * No-op flips (start, unchanged, already-stopped) plan nothing. Pure.
 */
export function planStopCloses(
  prev: CopybotConfig,
  next: CopybotConfig,
  openMirrors: StopCloseMirror[],
): StopClosePlan {
  const plan: StopClosePlan = { toClose: [] };
  if (openMirrors.length === 0) return plan;

  // Global stop wins: every open mirror closes, whatever its leader's own flags did.
  if (prev.user.enabled && !next.user.enabled) {
    plan.toClose = openMirrors.map((m) => ({ ...m, reason: 'user_stopped' as const }));
    return plan;
  }

  for (const m of openMirrors) {
    // Only an ACTUAL transition closes: the leader must have been STARTED in the config we were running. A mirror
    // whose leader was already stopped/absent in `prev` is owned by the earlier transition (or the reconcile),
    // not re-closed on every reload.
    if (!isStarted(prev, m.leaderAddress)) continue;
    const nextLeader = next.leaders.find((l) => l.address === m.leaderAddress);
    if (nextLeader === undefined) {
      plan.toClose.push({ ...m, reason: 'leader_removed' });
    } else if (!nextLeader.enabled) {
      plan.toClose.push({ ...m, reason: 'leader_stopped' });
    }
  }
  return plan;
}
