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

/** How `cfg` currently treats `leaderAddress`: `'leader_removed'` (absent from the list) or `'leader_stopped'`
 *  (present but disabled) — or `null` when it is still started. The per-leader half of a stop plan, shared by the
 *  live diff (`planStopCloses`) and the boot replay (`planBootStopCloses`) so the two paths can NEVER disagree on
 *  what counts as "stopped" (any drift there = a mirror closed on one path but silently stranded on the other). */
function leaderStopReason(
  cfg: CopybotConfig,
  leaderAddress: string,
): 'leader_removed' | 'leader_stopped' | null {
  const l = cfg.leaders.find((x) => x.address === leaderAddress);
  if (l === undefined) return 'leader_removed';
  return l.enabled ? null : 'leader_stopped';
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
    const reason = leaderStopReason(next, m.leaderAddress);
    if (reason !== null) plan.toClose.push({ ...m, reason });
  }
  return plan;
}


/**
 * Boot/seed FORCE-CLOSE planning (PURE, no I/O). A mirror is only ever persisted OPEN while BOTH the user AND its
 * leader are STARTED — the "open mirror ⇒ started leader" invariant. So when the brain (re)spawns a user from the
 * DB and finds a seeded open mirror the FRESH boot config no longer starts (leader disabled/removed, or the user
 * globally stopped), that is a STOP that was written while the brain was DOWN: force-close it. `planStopCloses`
 * cannot catch this — a fresh spawn has no `prev`≠`next` transition to observe — so here we replay from the
 * invariant instead of an observed `prev`. Like `planStopCloses` this NEVER plans an open (forward-only: enabling
 * a leader must not copy its already-open positions), and the caller's `RECLOSE_GRACE_MS` gate dedupes an
 * in-flight prior close so a stop caught mid-flight by a restart is not double-published.
 */
export function planBootStopCloses(
  boot: CopybotConfig,
  openMirrors: StopCloseMirror[],
): StopClosePlan {
  const plan: StopClosePlan = { toClose: [] };
  if (openMirrors.length === 0) return plan;

  // Global stop: the user is stopped in the config we booted with ⇒ every seeded mirror is stranded → close all.
  if (!boot.user.enabled) {
    plan.toClose = openMirrors.map((m) => ({ ...m, reason: 'user_stopped' as const }));
    return plan;
  }

  for (const m of openMirrors) {
    // A legacy '' mirror can't be attributed to a leader (the MirrorStore NULL→'' contract): exactly like
    // planStopCloses it is stopped-by-definition, so only the GLOBAL stop above closes it — never per-leader here.
    if (m.leaderAddress === '') continue;
    const reason = leaderStopReason(boot, m.leaderAddress);
    if (reason !== null) plan.toClose.push({ ...m, reason });
  }
  return plan;
}
