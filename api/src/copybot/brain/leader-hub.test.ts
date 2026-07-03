import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import { CONFIG_DEFAULTS, type CopybotConfig } from '@/domain/copybot/config';
import type { DetectedEvent } from '@/domain/copybot/events';
import type { EventSource } from '@/domain/copybot/leader-detector';
import { DETECTION_STALE_FAILURES } from '@/domain/copybot/status';
import { type FanOutRuntime, type HubDetector, LeaderHub, type TxWatcher } from './leader-hub';

const log = pino({ level: 'silent' });
const L1 = 'LeaderOne111111111111111111111111111111111';
const L2 = 'LeaderTwo222222222222222222222222222222222';

function mkEvent(over: Partial<DetectedEvent> = {}): DetectedEvent {
  return {
    signature: `sig-${Math.random().toString(36).slice(2)}`,
    blockTime: 1,
    instruction: 'AddLiquidityByStrategy2',
    depositSol: 1,
    withdrawSol: 0,
    claimSol: 0,
    closed: false,
    pool: 'POOL',
    position: 'LEADER_POS',
    nonSolMint: null,
    nonSolSymbol: null,
    ...over,
  };
}

function cfgCopying(leader: string, enabled = true): CopybotConfig {
  return {
    user: CONFIG_DEFAULTS.user,
    leaders: [{ address: leader, enabled, maxTotalExposureSol: null, overrides: {} }],
  };
}

/** A stub runtime recording its fan-out calls; `throws` simulates a broken tenant (S5 isolation). */
function stubRuntime(userId: string, over: { owns?: boolean; throws?: boolean } = {}) {
  const received: Array<{
    e: DetectedEvent;
    source: EventSource;
    leader: string;
    eventCount: number;
  }> = [];
  const systemEmits: Array<{ code: string }> = [];
  const rt: FanOutRuntime = {
    userId,
    onEvent: (e, source, leader, eventCount) => {
      if (over.throws) throw new Error(`runtime ${userId} broken`);
      received.push({ e, source, leader, eventCount });
    },
    ownsLeaderPosition: () => over.owns ?? false,
    events: {
      system: (code: string) => {
        systemEmits.push({ code });
      },
    } as unknown as Pick<CopyEvents, 'system'>,
  };
  return { rt, received, systemEmits };
}

/** A full hub harness: per-leader detector stubs (controllable poll outcomes + captured callbacks), a recording
 *  watcher, a recording shared emitter, and a mutable retention/config/runtime state. */
function makeHub(opts: {
  runtimes?: Map<string, FanOutRuntime>;
  configs?: Map<string, CopybotConfig>;
  retain?: (leader: string) => boolean;
  pollFails?: Set<string>; // leaders whose poll() rejects
}) {
  const calls: string[] = []; // ordered effect log (poll/watch/unwatch) — asserts sequencing
  const emitted: Array<{ code: string; fields: Record<string, unknown> }> = [];
  const detectors = new Map<
    string,
    {
      onEvent: (e: DetectedEvent, source: EventSource) => void;
      onGap: (sig: string, attempts: number) => void;
    }
  >();
  const pollFails = opts.pollFails ?? new Set<string>();
  const watcher: TxWatcher = {
    watch: (wallet) => {
      calls.push(`watch:${wallet}`);
    },
    unwatch: (wallet) => {
      calls.push(`unwatch:${wallet}`);
    },
    onReconnect: () => {},
  };
  const hub = new LeaderHub({
    log,
    events: {
      emit: (code: string, fields: Record<string, unknown>) => {
        emitted.push({ code, fields });
      },
    } as unknown as CopyEvents,
    makeDetector: (leader, onEvent, onGap): HubDetector => {
      detectors.set(leader, { onEvent, onGap });
      return {
        poll: async (source) => {
          calls.push(`poll:${leader}:${source ?? 'poll'}`);
          if (pollFails.has(leader)) throw new Error(`rpc down for ${leader}`);
        },
        onWsSignature: async () => {},
      };
    },
    getConfigs: () => opts.configs ?? new Map(),
    getRuntimes: () => opts.runtimes ?? new Map(),
    retainLeader: opts.retain ?? (() => false),
    watcher,
  });
  return { hub, calls, emitted, detectors, pollFails };
}

describe('LeaderHub — applyLeaderSet (S4)', () => {
  it('an ADDED leader is replay-seeded BEFORE being watched (forward-only, no pre-add copy window)', async () => {
    // WHY (SPEC §4.3): the replay poll sets the cursor + tracker WITHOUT publishing; watching first could deliver
    // a live event whose position state was never seeded — or worse, copy an open that predates the add.
    const { hub, calls } = makeHub({});
    await hub.applyLeaderSet(new Set([L1]));
    expect(calls).toEqual([`poll:${L1}:replay`, `watch:${L1}`]);
  });

  it('a REMOVED leader is unwatched but KEPT POLLING while retention holds (a mirror can still close)', async () => {
    // WHY (never-miss pillar): stop-closes are in flight after a remove; while any user's mirror survives
    // on-chain, the leader's own close events must stay detectable — only the WS trigger is dropped.
    let retained = true;
    const { hub, calls } = makeHub({ retain: () => retained });
    await hub.applyLeaderSet(new Set([L1]));
    await hub.applyLeaderSet(new Set());
    expect(calls).toContain(`unwatch:${L1}`);

    calls.length = 0;
    await hub.pollAll(); // draining but retained → still polled (completeness backstop)
    expect(calls).toEqual([`poll:${L1}:poll`]);

    retained = false; // last mirror confirmed gone
    calls.length = 0;
    await hub.pollAll(); // reaped before polling → quiescent entry deleted
    expect(calls).toEqual([]);
  });

  it('a leader re-added mid-drain is re-watched WITHOUT a second replay (its cursor never stopped)', async () => {
    const { hub, calls } = makeHub({ retain: () => true });
    await hub.applyLeaderSet(new Set([L1]));
    await hub.applyLeaderSet(new Set());
    await hub.applyLeaderSet(new Set([L1]));
    expect(calls.filter((c) => c === `poll:${L1}:replay`)).toHaveLength(1); // one seed only
    expect(calls.filter((c) => c === `watch:${L1}`)).toHaveLength(2); // boot + re-add
  });

  it('a failed replay seed discards the half-built entry (the next apply retries cleanly)', async () => {
    // WHY: registering an unseeded entry would poll from an undefined cursor and watch a leader whose tracker
    // never saw its open positions — fail loud at apply time, keep the hub consistent.
    const { hub, calls, pollFails } = makeHub({ pollFails: new Set([L1]) });
    await expect(hub.applyLeaderSet(new Set([L1]))).rejects.toThrow('rpc down');
    expect(calls).not.toContain(`watch:${L1}`);
    pollFails.delete(L1);
    calls.length = 0;
    await hub.applyLeaderSet(new Set([L1])); // retry seeds from scratch
    expect(calls).toEqual([`poll:${L1}:replay`, `watch:${L1}`]);
  });
});

describe('LeaderHub — event fan-out (S5)', () => {
  it('a live event reaches every user copying the leader; replay and position-less legs are dropped', async () => {
    const a = stubRuntime('user-a');
    const b = stubRuntime('user-b');
    const { hub, detectors } = makeHub({
      runtimes: new Map([
        ['user-a', a.rt],
        ['user-b', b.rt],
      ]),
      configs: new Map([
        ['user-a', cfgCopying(L1)],
        ['user-b', cfgCopying(L1)],
      ]),
    });
    await hub.applyLeaderSet(new Set([L1]));
    const det = detectors.get(L1);
    if (!det) throw new Error('no detector');

    det.onEvent(mkEvent(), 'replay'); // forward-only: a past open is NEVER copied
    det.onEvent(mkEvent({ position: '' }), 'ws'); // no decodable leg → no capital → dropped
    expect(a.received).toHaveLength(0);
    expect(b.received).toHaveLength(0);

    const live = mkEvent();
    det.onEvent(live, 'ws');
    // eventCount 2: the replay event above DID seed the tracker (that's the point of the replay poll) — only
    // the fan-out was suppressed for it.
    expect(a.received).toEqual([{ e: live, source: 'ws', leader: L1, eventCount: 2 }]);
    expect(b.received).toEqual([{ e: live, source: 'ws', leader: L1, eventCount: 2 }]);
  });

  it('detect.routed is emitted ONCE per on-chain fact via the SHARED emitter — never once per user', async () => {
    // WHY: detection is shared; duplicating the row per user would fabricate N detection rows for one event.
    const a = stubRuntime('user-a');
    const b = stubRuntime('user-b');
    const { hub, detectors, emitted } = makeHub({
      runtimes: new Map([
        ['user-a', a.rt],
        ['user-b', b.rt],
      ]),
      configs: new Map([
        ['user-a', cfgCopying(L1)],
        ['user-b', cfgCopying(L1)],
      ]),
    });
    await hub.applyLeaderSet(new Set([L1]));
    const e = mkEvent({ signature: 'SIG-ROUTED' });
    detectors.get(L1)?.onEvent(e, 'ws');
    const routed = emitted.filter((x) => x.code === 'detect.routed');
    expect(routed).toHaveLength(1);
    expect(routed[0]?.fields.eventKey).toBe('SIG-ROUTED:LEADER_POS');
    expect(routed[0]?.fields.leader).toBe(L1);
  });

  it('UNION clause: a runtime OWNING the position is targeted even when its user stopped the leader', async () => {
    // WHY (never-miss-close): user B stopped the leader mid-flight but still holds its open mirror — the leader's
    // close must still reach B's runtime (per-user config blocks any re-open; the close path must run).
    const a = stubRuntime('user-a');
    const b = stubRuntime('user-b', { owns: true });
    const c = stubRuntime('user-c'); // neither copying nor owning → never targeted
    const { hub, detectors } = makeHub({
      runtimes: new Map([
        ['user-a', a.rt],
        ['user-b', b.rt],
        ['user-c', c.rt],
      ]),
      configs: new Map([
        ['user-a', cfgCopying(L1)],
        ['user-b', cfgCopying(L1, false)], // stopped — not a usersCopying target
        ['user-c', cfgCopying(L2)],
      ]),
    });
    await hub.applyLeaderSet(new Set([L1]));
    detectors.get(L1)?.onEvent(mkEvent({ closed: true, instruction: 'ClosePosition' }), 'ws');
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1); // owner-union kept it
    expect(c.received).toHaveLength(0);
  });

  it("ISOLATION: runtime A's throwing enqueue never starves runtime B, and A gets its own loop_errored row", async () => {
    // WHY: one broken tenant must not consume the event for everyone — B's copy would be a silent miss.
    const a = stubRuntime('user-a', { throws: true });
    const b = stubRuntime('user-b');
    const { hub, detectors } = makeHub({
      runtimes: new Map([
        ['user-a', a.rt],
        ['user-b', b.rt],
      ]),
      configs: new Map([
        ['user-a', cfgCopying(L1)],
        ['user-b', cfgCopying(L1)],
      ]),
    });
    await hub.applyLeaderSet(new Set([L1]));
    detectors.get(L1)?.onEvent(mkEvent(), 'ws');
    expect(b.received).toHaveLength(1); // B still served
    expect(a.systemEmits).toEqual([{ code: 'system.loop_errored' }]); // A's failure attributed to A
  });

  it('detect.gap carries the LEADER in its eventKey (per-leader cursors gap independently)', async () => {
    const { hub, detectors, emitted } = makeHub({});
    await hub.applyLeaderSet(new Set([L1]));
    detectors.get(L1)?.onGap('SIG-GAP', 4);
    const gap = emitted.find((x) => x.code === 'detect.gap');
    expect(gap?.fields.eventKey).toBe(`gap:${L1}:SIG-GAP`);
    expect(gap?.fields.leader).toBe(L1);
  });
});

describe('LeaderHub — per-leader poll health + stale alerts (S4)', () => {
  it("leader A going stale alerts ONCE (keyed per leader) and never touches leader B's health", async () => {
    // WHY: with N leaders, one revoked RPC route must flag exactly the blind leader — muting it behind a healthy
    // one (or alerting for all) would hide which cursor is stalled.
    const { hub, emitted, pollFails } = makeHub({ pollFails: new Set() });
    await hub.applyLeaderSet(new Set([L1, L2]));
    pollFails.add(L1);
    for (let i = 0; i < DETECTION_STALE_FAILURES + 1; i++) await hub.pollAll(); // one past the threshold
    const stale = emitted.filter((x) => x.code === 'system.detection_stale');
    expect(stale).toHaveLength(1); // once per episode, not once per failing poll
    expect(stale[0]?.fields.leader).toBe(L1);
    expect(String(stale[0]?.fields.eventKey)).toContain(`detection-stale:${L1}:`);
    expect(hub.pollHealth().pollFailures).toBe(DETECTION_STALE_FAILURES + 1); // stalest leader wins the aggregate

    // Recovery re-arms: a NEW stale episode after a success must alert again (not stay muted forever).
    pollFails.delete(L1);
    await hub.pollAll();
    expect(hub.pollHealth().pollFailures).toBe(0);
    pollFails.add(L1);
    for (let i = 0; i < DETECTION_STALE_FAILURES; i++) await hub.pollAll();
    expect(emitted.filter((x) => x.code === 'system.detection_stale')).toHaveLength(2);
  });

  it('pollHealth reports the single leader exactly (heartbeat parity with the pre-hub counters)', async () => {
    const { hub } = makeHub({});
    await hub.applyLeaderSet(new Set([L1]));
    expect(hub.pollHealth()).toEqual({ lastPollAt: null, pollFailures: 0 }); // replay does NOT stamp lastPollAt
    const before = Date.now();
    await hub.pollAll();
    const health = hub.pollHealth();
    expect(health.pollFailures).toBe(0);
    expect(health.lastPollAt).toBeGreaterThanOrEqual(before);
  });
});
