/**
 * Copy-bot · Inc.3b — multi-user fan-out targeting (PURE, no I/O — INC3B-PLAN §1/§2).
 *
 * The LeaderHub watches the UNION of every active user's STARTED leaders and fans each detected event out to the
 * users copying that leader. These pure functions compute (a) the leader set the hub must watch, (b) the users a
 * leader's event targets, and (c) whether a REMOVED leader's hub entry must be RETAINED — a removed leader's own
 * close events must stay detectable while ANY user still holds an open mirror or a pending safety-close for it
 * (the never-miss-close pillar). Configs here are already parsed (`parseConfig` fails closed upstream, so a
 * corrupt config contributes no leaders and no targets).
 */
import type { CopybotConfig } from './config';

/** True iff this user copies `leader` RIGHT NOW: user master switch on AND the leader present + started. */
function copies(cfg: CopybotConfig, leader: string): boolean {
  return cfg.user.enabled && cfg.leaders.some((l) => l.address === leader && l.enabled);
}

/**
 * The leader wallets the hub must WATCH = union over enabled users of their STARTED leaders (SPEC §4.3: a stopped
 * or removed leader is not watched for NEW opens; its still-open mirrors are covered by the retention predicate).
 */
export function computeLeaderSet(configs: ReadonlyMap<string, CopybotConfig>): Set<string> {
  const out = new Set<string>();
  for (const cfg of configs.values()) {
    if (!cfg.user.enabled) continue;
    for (const l of cfg.leaders) if (l.enabled) out.add(l.address);
  }
  return out;
}

/**
 * The users a `leader` event fans out to for NEW copies (opens). The hub UNIONS this with the runtimes that
 * already OWN the event's position (closes/resyncs must reach a user whose leader was stopped mid-flight).
 */
export function usersCopying(
  leader: string,
  configs: ReadonlyMap<string, CopybotConfig>,
): string[] {
  const out: string[] = [];
  for (const [userId, cfg] of configs) if (copies(cfg, leader)) out.push(userId);
  return out;
}

/** What ONE runtime still holds that ties it to a leader (collected impurely by the brain, judged purely here). */
export interface LeaderHoldings {
  /** `leaderAddress` of each OPEN mirror. */
  openMirrorLeaders: ReadonlyArray<string>;
  /** `leaderAddress` of each pending rug-SL/stop close (retry-until-confirmed-gone); `null` when the pending
   *  entry can't be attributed to a leader (e.g. restored after a restart with its mirror row gone). */
  rugExitPendingLeaders: ReadonlyArray<string | null>;
  /** A6-03: `leaderAddress` of each OPEN still IN FLIGHT (its multi-tx continuation hasn't recorded the mirror yet).
   *  Retains the leader's detector so a stop/removal landing mid-open can't delete its only close channel before the
   *  funded mirror even registers — the forbidden un-managed position. */
  inFlightOpenLeaders: ReadonlyArray<string>;
}

/**
 * Must a REMOVED (draining) leader's hub entry be RETAINED? True while ANY runtime still holds an open mirror or
 * a pending safety-close for it — its close events must stay detectable until every mirror is confirmed gone.
 * An UNATTRIBUTABLE pending close (`null` leader) retains conservatively: over-polling a drained leader costs one
 * cheap poll per cycle; dropping it early could miss a close (the forbidden failure).
 */
export function shouldRetainLeader(
  leader: string,
  holdings: ReadonlyArray<LeaderHoldings>,
): boolean {
  return holdings.some(
    (h) =>
      h.openMirrorLeaders.includes(leader) ||
      h.inFlightOpenLeaders.includes(leader) || // A6-03: an open still landing keeps its detector alive
      h.rugExitPendingLeaders.some((l) => l === leader || l === null),
  );
}
