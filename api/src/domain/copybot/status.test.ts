import { describe, expect, it } from 'vitest';
import {
  assembleBrainStatus,
  type BrainStatusDetail,
  DETECTION_STALE_FAILURES,
  detectionHealthy,
  HEARTBEAT_STALE_MS,
  isOnline,
  LEGACY_LEADER_MULTI,
  shouldAlertDetectionStale,
} from './status';

describe('status · isOnline', () => {
  const now = 1_000_000;

  it('a recent beat is online', () => {
    expect(isOnline(now - 5_000, now)).toBe(true);
  });

  it('a beat older than the stale window is offline (a crashed process goes dark on its own)', () => {
    // WHY: online MUST be derived from staleness, not a stored flag — a crashed process can never set itself false.
    expect(isOnline(now - (HEARTBEAT_STALE_MS + 1), now)).toBe(false);
  });

  it('the stale boundary is inclusive so the edge does not flap', () => {
    expect(isOnline(now - HEARTBEAT_STALE_MS, now)).toBe(true);
    expect(isOnline(now - HEARTBEAT_STALE_MS - 1, now)).toBe(false);
  });

  it('never-beat (null) is offline', () => {
    expect(isOnline(null, now)).toBe(false);
  });

  it('honors a custom stale window', () => {
    expect(isOnline(now - 2_000, now, 1_000)).toBe(false);
    expect(isOnline(now - 500, now, 1_000)).toBe(true);
  });

  it('is unchanged by the detection-liveness fields — freshness alone drives online/offline', () => {
    // WHY: detection-stale is a SEPARATE signal; a stale detector must NOT flip the heartbeat online/offline
    // (that would double-count and could mask the real "process alive but blind" condition the alert exists for).
    expect(isOnline(now - 5_000, now)).toBe(true);
    expect(isOnline(now - (HEARTBEAT_STALE_MS + 1), now)).toBe(false);
  });
});

describe('status · assembleBrainStatus (Inc.3b S8 — the v2 heartbeat payload)', () => {
  const LEADER_A = 'LeaderA111';
  const LEADER_B = 'LeaderB222';
  const baseLeaders = [
    { leader: LEADER_A, lastPollAt: 100, pollFailures: 0 },
    { leader: LEADER_B, lastPollAt: 90, pollFailures: 2 },
  ];
  const health = { wsConnected: true, lastReconcileAt: 456, reconcileFailures: 1 };

  it('top-level open/exposure are AGGREGATES across users; users[] carries each tenant slice', () => {
    // WHY: a top-level number showing ONE user's healthy view over a broken second user would hide the breakage —
    // the legacy fields must describe the whole process, with the per-user truth alongside.
    const detail = assembleBrainStatus({
      users: [
        {
          userId: 'u1',
          openMirrors: [
            { leader: LEADER_A, sizeSol: 0.5 },
            { leader: LEADER_B, sizeSol: 0.25 },
          ],
          lastActionAt: 10,
          lastLatencyMs: 100,
        },
        {
          userId: 'u2',
          openMirrors: [{ leader: LEADER_A, sizeSol: 1 }],
          lastActionAt: null,
          lastLatencyMs: null,
        },
      ],
      leaders: baseLeaders,
      ...health,
    });
    expect(detail.openPositions).toBe(3);
    expect(detail.exposureSol).toBeCloseTo(1.75);
    expect(detail.users.map((u) => u.userId)).toEqual(['u1', 'u2']);
    expect(detail.users[0]?.openPositions).toBe(2);
    expect(detail.users[0]?.exposureSol).toBeCloseTo(0.75);
    expect(detail.users[1]?.exposureSol).toBeCloseTo(1);
  });

  it("perLeader groups ONE user's mirrors by the leader they copy (per-(user,leader) visibility)", () => {
    const detail = assembleBrainStatus({
      users: [
        {
          userId: 'u1',
          openMirrors: [
            { leader: LEADER_A, sizeSol: 0.5 },
            { leader: LEADER_A, sizeSol: 0.5 },
            { leader: LEADER_B, sizeSol: 0.25 },
          ],
          lastActionAt: null,
          lastLatencyMs: null,
        },
      ],
      leaders: baseLeaders,
      ...health,
    });
    expect(detail.users[0]?.perLeader).toEqual([
      { leader: LEADER_A, openPositions: 2, exposureSol: 1 },
      { leader: LEADER_B, openPositions: 1, exposureSol: 0.25 },
    ]);
  });

  it("lastActionAt is the MOST RECENT across users and lastLatencyMs travels WITH it (never another user's)", () => {
    // WHY: mixing user A's timestamp with user B's latency would fabricate a latency no action ever had — the
    // operator would chase a phantom slow path.
    const detail = assembleBrainStatus({
      users: [
        { userId: 'u1', openMirrors: [], lastActionAt: 50, lastLatencyMs: 999 },
        { userId: 'u2', openMirrors: [], lastActionAt: 80, lastLatencyMs: 42 },
      ],
      leaders: baseLeaders,
      ...health,
    });
    expect(detail.lastActionAt).toBe(80);
    expect(detail.lastLatencyMs).toBe(42);
  });

  it('no user acted yet ⇒ null/null (never a fabricated zero)', () => {
    const detail = assembleBrainStatus({
      users: [{ userId: 'u1', openMirrors: [], lastActionAt: null, lastLatencyMs: null }],
      leaders: [],
      ...health,
    });
    expect(detail.lastActionAt).toBeNull();
    expect(detail.lastLatencyMs).toBeNull();
  });

  it("legacy `leader` = the single watched leader; 'multi' when several; '' when none", () => {
    // WHY: v1 consumers read one leader string — with N leaders any single address would be a lie; the sentinel
    // says "look at leaders[]" without breaking a loose jsonb read.
    const one = assembleBrainStatus({ users: [], leaders: [baseLeaders[0]!], ...health });
    expect(one.leader).toBe(LEADER_A);
    const many = assembleBrainStatus({ users: [], leaders: baseLeaders, ...health });
    expect(many.leader).toBe(LEGACY_LEADER_MULTI);
    const none = assembleBrainStatus({ users: [], leaders: [], ...health });
    expect(none.leader).toBe('');
  });

  it('leaders[] carries the per-leader poll health verbatim (replaces the v1 singletons)', () => {
    // WHY: with N leaders a single lastPollAt/pollFailures pair can only describe the stalest one — per-leader
    // health is what makes "blind to leader X only" visible.
    const detail = assembleBrainStatus({ users: [], leaders: baseLeaders, ...health });
    expect(detail.leaders).toEqual(baseLeaders);
    expect(detail.wsConnected).toBe(true);
    expect(detail.lastReconcileAt).toBe(456);
    expect(detail.reconcileFailures).toBe(1);
  });

  it('the jsonb stays loosely readable: a fresh payload still satisfies the (optional) legacy field shape', () => {
    const detail: BrainStatusDetail = assembleBrainStatus({ users: [], leaders: [], ...health });
    // The v1-optional detection fields remain optional — an old persisted row without them still type-checks.
    const legacy: BrainStatusDetail = {
      leader: 'L',
      openPositions: 1,
      exposureSol: 2,
      lastActionAt: 1,
      lastLatencyMs: 2,
      users: [],
      leaders: [],
    };
    expect(legacy.wsConnected).toBeUndefined();
    expect(detail.wsConnected).toBe(true);
  });
});

describe('status · detectionHealthy', () => {
  it('is healthy only when BOTH consecutive-failure counters are zero', () => {
    expect(detectionHealthy(0, 0)).toBe(true);
    expect(detectionHealthy(1, 0)).toBe(false);
    expect(detectionHealthy(0, 1)).toBe(false);
    expect(detectionHealthy(3, 3)).toBe(false);
  });
});

describe('status · shouldAlertDetectionStale', () => {
  const T = DETECTION_STALE_FAILURES;

  it('does NOT alert below the threshold', () => {
    // WHY: a single transient poll blip must not page the operator — only a persistent (N-in-a-row) outage does.
    expect(shouldAlertDetectionStale(T - 1, 0, false)).toBe(false);
    expect(shouldAlertDetectionStale(0, T - 1, false)).toBe(false);
  });

  it('alerts once EITHER loop reaches the threshold', () => {
    expect(shouldAlertDetectionStale(T, 0, false)).toBe(true); // poll blind
    expect(shouldAlertDetectionStale(0, T, false)).toBe(true); // reconcile blind (missed-close backstop down)
  });

  it('gates to ONCE per stale episode (already-alerted suppresses the repeat)', () => {
    // WHY: emitting the pinned alert every tick would flood the operator channel; the flag is the episode gate.
    expect(shouldAlertDetectionStale(T + 5, T + 5, true)).toBe(false);
  });

  it('re-arms after recovery: alerted flag cleared once healthy → a fresh outage alerts again', () => {
    // Episode 1: crosses threshold, alerts, flag set.
    expect(shouldAlertDetectionStale(T, 0, false)).toBe(true);
    // Recovery zeroes the counter → caller clears the flag via detectionHealthy.
    expect(detectionHealthy(0, 0)).toBe(true);
    // Episode 2: a new outage with the flag cleared alerts again (no missed episode).
    expect(shouldAlertDetectionStale(T, 0, false)).toBe(true);
  });

  it('honors a custom threshold', () => {
    expect(shouldAlertDetectionStale(2, 0, false, 2)).toBe(true);
    expect(shouldAlertDetectionStale(1, 0, false, 2)).toBe(false);
  });
});
