import type {
  ClosedPosition,
  LiveEvent,
  NotifRule,
  OpenPosition,
  WalletState,
} from '@binsight/shared';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigRepository, NotificationChannel, PresenceReader } from '@/domain/ports';
import { EventBus } from '../event-bus';
import { NotificationManager } from './manager';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

// STARTUP_GRACE_MS in the manager is 10s. The grace ends on a TIMER (that is what releases the held
// deliveries), so every test fakes timers + Date together and crosses the grace by advancing time.
const BOOT = new Date('2026-01-01T00:00:00Z');
const GRACE_MS = 10_000;

/** Build a NotifRule with sane defaults; only the discriminating fields need to be passed. */
function makeRule(over: Partial<NotifRule> & Pick<NotifRule, 'eventKind'>): NotifRule {
  return {
    wallet: null, // global default
    enabled: true,
    mode: 'single',
    threshold: null,
    oorMinutes: null,
    ...over,
  };
}

const pnlRule: NotifRule = makeRule({ eventKind: 'pnl_threshold', threshold: 1 });

/** A minimal open position; only the fields the manager's gating logic reads are meaningful. */
function openPos(over: Partial<OpenPosition> & { positionAddress: string }): OpenPosition {
  return {
    wallet: 'W',
    tokenX: 'AAA',
    tokenY: 'SOL',
    sizeSol: 1,
    pnlSol: 0,
    unclaimedFeesSol: 0,
    rangeStatus: 'in',
    outOfRangeSince: null,
    ...over,
  } as unknown as OpenPosition;
}

function stateOf(positions: OpenPosition[], scope = 'W'): WalletState {
  return { scope, openPositions: positions } as unknown as WalletState;
}

/** A focused-scope (not 'all') state with one open position breaching the pnl threshold. */
function breachState(positionAddress: string, pnlSol: number): WalletState {
  return stateOf([openPos({ positionAddress, pnlSol })]);
}

/** A fully-formed raw LiveEvent (the kind that flows through `handle`). */
function rawEvent(over: Partial<LiveEvent> & Pick<LiveEvent, 'kind'>): LiveEvent {
  return {
    id: 'e1',
    wallet: 'W',
    positionAddress: 'P',
    pair: 'AAA/SOL',
    title: 'title',
    body: 'body',
    data: {},
    createdAt: 0,
    ...over,
  };
}

// `deliver` awaits pushChannel before consulting presence → flush microtasks to observe notify/bark.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function makeManager(rules: NotifRule[], opts: { active?: boolean } = {}) {
  const bus = new EventBus();
  const config = { listNotifRules: () => rules } as unknown as ConfigRepository;
  const presence: PresenceReader = { isAnyClientActive: () => opts.active ?? false };
  const push = { name: 'push', deliver: vi.fn(async (_e: LiveEvent) => {}) };
  const bark = { name: 'bark', deliver: vi.fn(async (_e: LiveEvent) => {}) };
  const notify = vi.fn();
  bus.on('notify', notify);
  const mgr = new NotificationManager(
    bus,
    config,
    presence,
    bark as unknown as NotificationChannel,
    push as unknown as NotificationChannel,
    noopLogger,
  );
  return { bus, mgr, push, bark, notify };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BOOT);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Start the manager and let the startup grace run out (releasing anything held — nothing, here). */
function startPastGrace(mgr: NotificationManager): void {
  mgr.start();
  vi.advanceTimersByTime(GRACE_MS);
}

describe('NotificationManager — startup grace (R02)', () => {
  it('fires a breach that existed at boot once grace passes (not suppressed forever)', () => {
    const { bus, mgr, push } = makeManager([pnlRule]);
    mgr.start(); // startAt = now → in grace

    // In grace: held AND not marked (the bug marked it here, suppressing it forever).
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).not.toHaveBeenCalled();

    // Past grace: the still-breached state must now alert exactly once.
    vi.advanceTimersByTime(GRACE_MS);
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).toHaveBeenCalledTimes(1);

    // The once-guard holds on subsequent identical ticks.
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationManager — threshold key reclamation (R07)', () => {
  it('forgets a position threshold key on close so the Set does not leak', () => {
    const { bus, mgr, push } = makeManager([pnlRule]);
    startPastGrace(mgr);

    bus.emit('state', breachState('P', 2));
    bus.emit('state', breachState('P', 2)); // once-guarded → still a single alert
    expect(push.deliver).toHaveBeenCalledTimes(1);

    // Closing the position must reclaim its 'pnl:P' key (no leak). The close event itself has no rule.
    bus.emit('closed', {
      wallet: 'W',
      positionAddress: 'P',
      tokenX: 'AAA',
      tokenY: 'SOL',
      pnlSol: 0,
      feesSol: 0,
    } as unknown as ClosedPosition);
    expect(push.deliver).toHaveBeenCalledTimes(1);

    // Proof the key was forgotten: an identical breach can fire again (the stale key no longer suppresses).
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationManager — rule gating (ruleFor)', () => {
  it('a per-wallet rule overrides the global default (disabled wallet rule suppresses an enabled global)', () => {
    const globalOn = makeRule({ eventKind: 'position_open', wallet: null, enabled: true });
    const walletOff = makeRule({ eventKind: 'position_open', wallet: 'W', enabled: false });
    const { bus, mgr, push } = makeManager([globalOn, walletOff]);
    startPastGrace(mgr);

    // ruleFor must pick the more-specific wallet rule (disabled) over the enabled global → no delivery.
    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled();
  });

  it('no matching rule → no delivery (events for unconfigured kinds are dropped)', () => {
    // Only a pnl rule configured; a position_open event has no rule.
    const { bus, mgr, push } = makeManager([pnlRule]);
    startPastGrace(mgr);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled();
  });

  it('a disabled rule → no delivery even when the kind matches', () => {
    const disabled = makeRule({ eventKind: 'position_open', enabled: false });
    const { bus, mgr, push } = makeManager([disabled]);
    startPastGrace(mgr);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled();
  });
});

describe('NotificationManager — bulk vs single routing (handle)', () => {
  it('a bulk-mode event is coalesced (not delivered immediately) and flushed once after the window', () => {
    const bulkOpen = makeRule({ eventKind: 'position_open', mode: 'bulk' });
    const { bus, mgr, push } = makeManager([bulkOpen]);
    startPastGrace(mgr);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled(); // held in the bulk buffer, not delivered inline

    vi.advanceTimersByTime(8_000); // BulkBuffer window elapses → flush
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationManager — deriveFromState gating', () => {
  it("the aggregated 'all' scope never derives notifications (avoids per-wallet double counting)", () => {
    const { bus, mgr, push } = makeManager([pnlRule]);
    startPastGrace(mgr);

    // Same breaching position, but under the aggregated 'all' scope → must short-circuit.
    bus.emit('state', stateOf([openPos({ positionAddress: 'P', pnlSol: 5 })], 'all'));
    expect(push.deliver).not.toHaveBeenCalled();
  });

  it('a fees_threshold breach fires once and stays deduped on repeat ticks', () => {
    const feeRule = makeRule({ eventKind: 'fees_threshold', threshold: 0.5 });
    const { bus, mgr, push } = makeManager([feeRule]);
    startPastGrace(mgr);

    const tick = () =>
      bus.emit('state', stateOf([openPos({ positionAddress: 'P', unclaimedFeesSol: 0.9 })]));
    tick();
    tick();
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });

  it('dropping back below the threshold re-arms the alert (a later re-breach fires again)', () => {
    const { bus, mgr, push } = makeManager([pnlRule]); // threshold 1
    startPastGrace(mgr);

    bus.emit('state', breachState('P', 2)); // breach → fire
    expect(push.deliver).toHaveBeenCalledTimes(1);

    bus.emit('state', breachState('P', 0)); // below threshold → key cleared (re-armed), no fire
    expect(push.deliver).toHaveBeenCalledTimes(1);

    bus.emit('state', breachState('P', 2)); // breach again → fires a second time
    expect(push.deliver).toHaveBeenCalledTimes(2);
  });

  it('oor_duration fires only once the position has been out of range long enough', () => {
    const oorRule = makeRule({ eventKind: 'oor_duration', oorMinutes: 30 });
    const { bus, mgr, push } = makeManager([oorRule]);
    startPastGrace(mgr);
    const now = Date.now();

    // Out of range for only 10 min < 30 → no alert.
    bus.emit(
      'state',
      stateOf([openPos({ positionAddress: 'P', outOfRangeSince: now - 10 * 60_000 })]),
    );
    expect(push.deliver).not.toHaveBeenCalled();

    // A different position out of range for 31 min ≥ 30 → fires once; repeat tick stays deduped.
    const longState = stateOf([
      openPos({ positionAddress: 'Q', outOfRangeSince: now - 31 * 60_000 }),
    ]);
    bus.emit('state', longState);
    bus.emit('state', longState);
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationManager — startup grace holds deliveries (not drops)', () => {
  it('an event delivered inside the grace is HELD, then sent once when the grace ends', async () => {
    // Downtime closes are found by the first sync after boot — typically inside the grace, before any
    // client has reconnected. Dropping them would lose the one alert the user most needs.
    const openRule = makeRule({ eventKind: 'position_open' });
    const { bus, mgr, push, bark } = makeManager([openRule]);
    mgr.start(); // in grace

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W', id: 'held' }));
    await flush();
    expect(push.deliver).not.toHaveBeenCalled(); // presence is unknown yet → wait
    expect(bark.deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(push.deliver).not.toHaveBeenCalled(); // still in grace

    vi.advanceTimersByTime(1); // grace ends → the held event is released
    await flush();
    expect(push.deliver).toHaveBeenCalledTimes(1);
    expect((push.deliver.mock.calls[0]![0] as LiveEvent).id).toBe('held');
    // Released through the normal presence routing: nobody viewing → Bark fallback too.
    expect(bark.deliver).toHaveBeenCalledTimes(1);

    // Released exactly once: nothing re-sends it later, and post-grace events go out inline.
    vi.advanceTimersByTime(GRACE_MS);
    expect(push.deliver).toHaveBeenCalledTimes(1);
    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W', id: 'live' }));
    expect(push.deliver).toHaveBeenCalledTimes(2);
  });

  it('a close found during the grace goes out after it, in arrival order with other held events', async () => {
    const closeRule = makeRule({ eventKind: 'position_close' });
    const openRule = makeRule({ eventKind: 'position_open' });
    const { bus, mgr, push } = makeManager([closeRule, openRule], { active: true });
    mgr.start();

    bus.emit('closed', {
      wallet: 'W',
      positionAddress: 'P',
      tokenX: 'AAA',
      tokenY: 'SOL',
      pnlSol: 1,
      feesSol: 0.5,
    } as unknown as ClosedPosition);
    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GRACE_MS);
    await flush();
    expect(push.deliver.mock.calls.map((c) => (c[0] as LiveEvent).kind)).toEqual([
      'position_close',
      'position_open',
    ]);
  });

  it('a bulk group that flushes inside the grace is held too, not lost', async () => {
    // The 8 s bulk window is shorter than the 10 s grace, so a boot-time burst flushes while still held.
    const bulkClose = makeRule({ eventKind: 'position_close', mode: 'bulk' });
    const { bus, mgr, push } = makeManager([bulkClose]);
    mgr.start();

    bus.emit('event', rawEvent({ kind: 'position_close', pair: 'AAA/SOL' }));
    bus.emit('event', rawEvent({ kind: 'position_close', pair: 'BBB/SOL' }));
    vi.advanceTimersByTime(8_000); // bulk window flushes → into the held queue
    expect(push.deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GRACE_MS - 8_000);
    await flush();
    expect(push.deliver).toHaveBeenCalledTimes(1);
    expect((push.deliver.mock.calls[0]![0] as LiveEvent).body).toBe('AAA/SOL, BBB/SOL');
  });
});

describe('NotificationManager — opened / rangeChanged bus events', () => {
  /** Every raw event the manager puts on the bus (the ungated live feed clients render). */
  function feed(bus: EventBus): LiveEvent[] {
    const events: LiveEvent[] = [];
    bus.on('event', (e) => events.push(e));
    return events;
  }

  it("'opened' → a position_open event, sized in the pool's native quote", () => {
    const { bus, mgr, push } = makeManager([makeRule({ eventKind: 'position_open' })]);
    const events = feed(bus);
    startPastGrace(mgr);

    bus.emit(
      'opened',
      openPos({ positionAddress: 'P', tokenY: 'USDC', quoteSymbol: 'USDC', sizeQuote: 250 }),
    );

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe('position_open');
    expect(e.positionAddress).toBe('P');
    expect(e.wallet).toBe('W');
    // A USDC position is announced in USDC, not as a SOL figure mislabelled.
    expect(e.body).toBe('opened · +250.0000 USDC');
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });

  it("'opened' of a SOL pool without a quote size falls back to its SOL size", () => {
    const { bus, mgr } = makeManager([]);
    const events = feed(bus);
    startPastGrace(mgr);

    bus.emit('opened', openPos({ positionAddress: 'P', sizeSol: 2 }));
    expect(events[0]!.body).toBe('opened · +2.0000 SOL');
  });

  it("'rangeChanged' out → oor_enter naming the side; back in → oor_return", () => {
    const enter = makeRule({ eventKind: 'oor_enter' });
    const back = makeRule({ eventKind: 'oor_return' });
    const { bus, mgr, push } = makeManager([enter, back]);
    const events = feed(bus);
    startPastGrace(mgr);

    bus.emit('rangeChanged', {
      position: openPos({ positionAddress: 'P', rangeStatus: 'out_up' }),
      outOfRange: true,
    });
    bus.emit('rangeChanged', {
      position: openPos({ positionAddress: 'Q', rangeStatus: 'out_down' }),
      outOfRange: true,
    });
    bus.emit('rangeChanged', {
      position: openPos({ positionAddress: 'P', rangeStatus: 'in' }),
      outOfRange: false,
    });

    expect(events.map((e) => [e.kind, e.body, e.data])).toEqual([
      ['oor_enter', 'out of range (above)', { side: 'above' }],
      ['oor_enter', 'out of range (below)', { side: 'below' }],
      ['oor_return', 'back in range', { side: null }],
    ]);
    expect(push.deliver).toHaveBeenCalledTimes(3);
  });

  it('the derived events stay rule-gated: on the live feed, but not pushed without a rule', () => {
    const { bus, mgr, push } = makeManager([]); // no rules at all
    const events = feed(bus);
    startPastGrace(mgr);

    bus.emit('opened', openPos({ positionAddress: 'P' }));
    bus.emit('rangeChanged', {
      position: openPos({ positionAddress: 'P', rangeStatus: 'out_up' }),
      outOfRange: true,
    });
    expect(events.map((e) => e.kind)).toEqual(['position_open', 'oor_enter']);
    expect(push.deliver).not.toHaveBeenCalled();
  });
});

describe('NotificationManager — delivery routing (deliver)', () => {
  it('with a client actively viewing: web-push + in-app notify, NO Bark fallback', async () => {
    const openRule = makeRule({ eventKind: 'position_open' });
    const { bus, mgr, push, bark, notify } = makeManager([openRule], { active: true });
    startPastGrace(mgr);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    await flush();

    expect(push.deliver).toHaveBeenCalledTimes(1); // universal channel always fires
    expect(notify).toHaveBeenCalledTimes(1); // active client → in-app banner
    expect(bark.deliver).not.toHaveBeenCalled(); // external fallback suppressed
  });

  it('with no client active: web-push + Bark fallback, NO in-app notify', async () => {
    const openRule = makeRule({ eventKind: 'position_open' });
    const { bus, mgr, push, bark, notify } = makeManager([openRule], { active: false });
    startPastGrace(mgr);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    await flush();

    expect(push.deliver).toHaveBeenCalledTimes(1); // universal channel always fires
    expect(bark.deliver).toHaveBeenCalledTimes(1); // no viewer → external fallback
    expect(notify).not.toHaveBeenCalled(); // no in-app banner without a viewer
  });
});

describe('NotificationManager — close fan-out (handleClosed)', () => {
  it('emits a position_close event with the settled PnL/fees body and routes it via the close rule', async () => {
    const closeRule = makeRule({ eventKind: 'position_close' });
    const { bus, mgr, push } = makeManager([closeRule]);
    startPastGrace(mgr);

    bus.emit('closed', {
      wallet: 'W',
      positionAddress: 'P',
      tokenX: 'AAA',
      tokenY: 'SOL',
      pnlSol: 1,
      feesSol: 0.5,
    } as unknown as ClosedPosition);
    await flush();

    expect(push.deliver).toHaveBeenCalledTimes(1);
    const delivered = push.deliver.mock.calls[0]![0] as LiveEvent;
    expect(delivered.kind).toBe('position_close');
    expect(delivered.title).toBe('AAA/SOL closed');
    expect(delivered.body).toContain('PnL +1.0000 SOL');
    expect(delivered.body).toContain('fees +0.5000 SOL');
  });
});
