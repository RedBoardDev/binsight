import type { Health, OpenPosition, WalletState } from '@binsight/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/application/event-bus';
import { HealthMonitor } from '@/application/health-monitor';
import type { OnchainValued } from '@/domain/dlmm';
import type { ConnectionStatus } from '@/domain/ports';
import { StateEmitter, type WalletView } from './emitter';

/** Minimal WS-backbone stub — the emitter only reads isConnected(). */
function fakeBackbone(connected: () => boolean): ConnectionStatus {
  return { isConnected: connected };
}

function setup(connected: () => boolean = () => true) {
  const wallets = new Map<string, WalletView>();
  const bus = new EventBus();
  const health = new HealthMonitor();
  const emitter = new StateEmitter(wallets, fakeBackbone(connected), bus, health);
  const emits: Health[] = [];
  const states: WalletState[] = [];
  bus.on('health', (h) => emits.push(h));
  bus.on('state', (s) => states.push(s));
  return { wallets, bus, health, emitter, emits, states };
}

function valued(overrides: Partial<OnchainValued> = {}): OnchainValued {
  return {
    slot: 100,
    slotSkew: 0,
    tvlSol: 0,
    idleSol: 1,
    unclaimedFeesSol: 0,
    lockedRentSol: 0,
    walletTotalSol: 1,
    positionCount: 0,
    chainComplete: true,
    valuationStatus: 'complete',
    authoritative: true,
    complete: true,
    sizeSolByPosition: new Map(),
    feeSolByPosition: new Map(),
    ...overrides,
  };
}

function openRow(positionAddress: string, wallet: string): OpenPosition {
  return {
    positionAddress,
    wallet,
    poolAddress: 'Pool',
    tokenX: 'TOK',
    tokenY: 'SOL',
    tokenXMint: 'Tok',
    strategy: null,
    sizeSol: 1,
    pnlSol: 0,
    pnlPctSol: 0,
    claimedFeesSol: 0,
    unclaimedFeesSol: 0,
    rangeStatus: 'in',
    minPrice: 0,
    maxPrice: 1,
    poolPrice: 0.5,
    outOfRangeSince: null,
    openedAt: null,
    updatedAt: 1,
  };
}

describe('StateEmitter.emitHealth — emit-on-change', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits on the first tick then dedups identical ticks (no idle per-second churn)', () => {
    // WHY: the WS layer re-sorts/filters/stringifies the health frame per distinct watched-set on every
    // emit — O(users × wallets). A tick where nothing a client renders changed must not re-broadcast.
    const { emitter, emits } = setup();
    emitter.emitHealth();
    emitter.emitHealth();
    emitter.emitHealth();
    expect(emits).toHaveLength(1);
  });

  it('does NOT re-emit when only uptime advances (monotonic field excluded from the signature)', () => {
    // WHY: uptimeSeconds ticks every second; if it counted toward the change signature it would defeat
    // the dedup and the O(users × wallets) churn would come straight back. The clock is pinned so the
    // ONLY difference between the two frames is the mocked uptime.
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const uptime = vi.spyOn(process, 'uptime');
    const { emitter, emits } = setup();
    uptime.mockReturnValue(10);
    emitter.emitHealth();
    uptime.mockReturnValue(45);
    emitter.emitHealth();
    expect(emits).toHaveLength(1);
  });

  it('does NOT re-emit when only source timestamps advance (the prod defect)', () => {
    // WHY: emitHealth calls health.set('ws','ok') every tick, which bumps sources[].lastOkAt to the
    // current clock. If those raw timestamps counted toward the signature the dedup would NEVER fire in
    // production. Here the clock advances between two otherwise-identical ticks; it must dedup.
    const now = vi.spyOn(Date, 'now');
    const { emitter, emits } = setup();
    now.mockReturnValue(1_000); // first tick sets ws lastOkAt = 1000
    emitter.emitHealth();
    now.mockReturnValue(9_999); // second tick bumps ws lastOkAt = 9999, nothing else changed
    emitter.emitHealth();
    expect(emits).toHaveLength(1);
  });

  it('re-emits immediately when a rendered field changes (chain tip, ws, a source status)', () => {
    // WHY: freshness must be preserved — a real status change reaches viewers on the next tick.
    const connected = { v: true };
    const { emitter, emits, health } = setup(() => connected.v);
    emitter.emitHealth();
    expect(emits).toHaveLength(1);

    health.setChainTip(1000); // chain tip advanced → new frame
    emitter.emitHealth();
    expect(emits).toHaveLength(2);

    connected.v = false; // ws dropped → new frame, and the ws source reads 'down'
    emitter.emitHealth();
    expect(emits).toHaveLength(3);
    expect(emits[2]?.wsConnected).toBe(false);
    expect(emits[2]?.sources.find((s) => s.name === 'ws')?.status).toBe('down');

    health.record('rpc', false, 'timeout'); // an RPC failure → rpc 'lagging' → new frame
    emitter.emitHealth();
    expect(emits).toHaveLength(4);
  });

  it('snapshotHealth() returns the full payload without emitting', () => {
    // WHY: a freshly-connected WS client must be handed the CURRENT health on connect (emit-on-change
    // means it wouldn't otherwise get a frame until the next real change).
    vi.spyOn(process, 'uptime').mockReturnValue(88);
    const { emitter, emits } = setup();
    const snap = emitter.snapshotHealth();
    expect(snap).toMatchObject({ ok: true, wsConnected: true, uptimeSeconds: 88 });
    expect(Array.isArray(snap.sources)).toBe(true);
    expect(emits).toHaveLength(0); // pure read — it must NOT emit
  });

  it('snapshotHealth() does not touch the dedup state (a following emit still fires)', () => {
    // WHY: the connect-time snapshot must be side-effect-free — it must not make the next emitHealth
    // skip by pre-seeding the last signature.
    const { emitter, emits } = setup();
    emitter.snapshotHealth();
    emitter.snapshotHealth();
    emitter.emitHealth();
    expect(emits).toHaveLength(1);
  });

  it('emits exactly the wire shape (the dedup is transparent to consumers)', () => {
    // WHY: the frame a client receives is the Health contract — ok / ws / tip / sources / uptime and
    // nothing else (the retired wallets / effectiveRps / meteoraOk fields must not creep back).
    vi.spyOn(process, 'uptime').mockReturnValue(77);
    const { emitter, emits } = setup();
    emitter.emitHealth();
    expect(Object.keys(emits[0] ?? {}).sort()).toEqual(
      ['chainTipSlot', 'ok', 'sources', 'uptimeSeconds', 'wsConnected'].sort(),
    );
    expect(emits[0]).toMatchObject({
      ok: true,
      wsConnected: true,
      chainTipSlot: null,
      uptimeSeconds: 77,
    });
  });
});

describe('StateEmitter — wallet states', () => {
  it('emitState emits the wallet state built from its open set + last exact valuation', () => {
    // WHY: this is the actor's onState — every exact read reaches viewers through it, labelled 'fresh'.
    const { emitter, wallets, states } = setup();
    wallets.set('W', { open: new Map([['P', openRow('P', 'W')]]), onchain: valued() });
    emitter.emitState('W');
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ scope: 'W', freshness: 'fresh' });
    expect(states[0]?.openPositions.map((p) => p.positionAddress)).toEqual(['P']);
  });

  it('emitState / emitMarked ignore a wallet that is not monitored (removed mid-flight)', () => {
    // WHY: a step or a price mark can still be in flight when the wallet is removed; its late result
    // must not resurrect the wallet for viewers.
    const { emitter, states } = setup();
    emitter.emitState('gone');
    emitter.emitMarked('gone', [], valued());
    expect(states).toHaveLength(0);
  });

  it('emitMarked surfaces a non-authoritative mark as syncing (never recorded as net worth)', () => {
    // WHY: the price mark holds amounts fixed — it is an approximation. The NetworthRecorder only keeps
    // 'fresh' states, so the mark must never read as one.
    const { emitter, wallets, states } = setup();
    wallets.set('W', { open: new Map(), onchain: valued() });
    emitter.emitMarked(
      'W',
      [openRow('P', 'W')],
      valued({ authoritative: false, walletTotalSol: 2 }),
    );
    expect(states[0]).toMatchObject({ scope: 'W', freshness: 'syncing' });
    expect(states[0]?.totals.walletTotalSol).toBe(2);
  });

  it('getState aggregates only the listed wallets, under the given scope', () => {
    // WHY: a viewer's state is its watchlist — another user's wallets must not leak into its totals.
    const { emitter, wallets } = setup();
    wallets.set('A', {
      open: new Map([['PA', openRow('PA', 'A')]]),
      onchain: valued({ idleSol: 1, walletTotalSol: 1 }),
    });
    wallets.set('B', {
      open: new Map([['PB', openRow('PB', 'B')]]),
      onchain: valued({ idleSol: 2, walletTotalSol: 2 }),
    });
    wallets.set('C', { open: new Map(), onchain: valued({ idleSol: 40, walletTotalSol: 40 }) });
    const s = emitter.getState(['A', 'B', 'unknown'], 'mine');
    expect(s.scope).toBe('mine');
    expect(s.openPositions.map((p) => p.positionAddress).sort()).toEqual(['PA', 'PB']);
    expect(s.totals.walletTotalSol).toBe(3);
  });
});
