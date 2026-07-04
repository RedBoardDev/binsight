import { PGlite } from '@electric-sql/pglite';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { deriveCommandId } from '@/copybot/command-id';
import type { HeartbeatStore } from '@/copybot/heartbeat-store';
import { checkCaps } from '@/domain/copybot/caps';
import { CONFIG_DEFAULTS } from '@/domain/copybot/config';
import type { TokenSnapshot } from '@/domain/copybot/filters';
import { TtlCache } from '@/domain/copybot/ttl-cache';
import type { LoadedPoolMeta } from '@/domain/dlmm';
import type { ControlChannel } from '@/infrastructure/bus/control-channel';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import type { Database } from '@/infrastructure/persistence/database';
import { FeeLedgerRepository } from '@/infrastructure/persistence/fee-ledger-repository';
import { PositionLedgerRepository } from '@/infrastructure/persistence/position-ledger-repository';
import * as schema from '@/infrastructure/persistence/schema';
import { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';
import type { OnchainPoolMetaReader } from '@/infrastructure/solana/dlmm/pool-meta';
import type { PriorityFeeOracle } from '@/infrastructure/solana/priority-fee-oracle';
import type { HeliusTokenMetadataGateway } from '@/infrastructure/solana/token-metadata-gateway';

// The Meteora SDK only loads BUNDLED (its ESM build breaks on dir-imports under vitest/tsx — see
// dlmm-tx-builder.ts). user-runtime imports the tx-builder (⇒ the SDK) transitively; none of these isolation
// tests ever call a build path, so the SDK is mocked with JUST enough surface for dlmm-tx-builder's module-load
// `assertSdkConstants()` (26/70 mirror the open-routing constants; the real drift guard runs in the bundle/bench).
vi.mock('@meteora-ag/dlmm', () => ({
  default: class {},
  DEFAULT_BIN_PER_POSITION: { toNumber: () => 70 },
  MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX: 26,
  StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 },
}));

// The too-wide open test (below) drives handleOpen to the `dist.length > MAX_SINGLE_POSITION_BINS` guard, which
// sits AFTER the leader-shape read. Override JUST the two RPC seams on that path (real for every other export):
// `createDlmmPair` (a discarded dummy — the guard returns before any build) and `readLeaderPositionShape` (driven
// per-test to a wide one-sided shape). No other test in this file calls either, so their behavior is unchanged.
vi.mock('@/infrastructure/solana/dlmm/dlmm-tx-builder', async (orig) => {
  const actual = await orig<typeof import('@/infrastructure/solana/dlmm/dlmm-tx-builder')>();
  return { ...actual, createDlmmPair: vi.fn(async () => ({}) as never) };
});
vi.mock('@/infrastructure/solana/dlmm/leader-position-reader', async (orig) => {
  const actual = await orig<typeof import('@/infrastructure/solana/dlmm/leader-position-reader')>();
  return { ...actual, readLeaderPositionShape: vi.fn() };
});

import { createDlmmPair } from '@/infrastructure/solana/dlmm/dlmm-tx-builder';
import { readLeaderPositionShape } from '@/infrastructure/solana/dlmm/leader-position-reader';
import { createUserRuntime, INFLIGHT_BUY_GRACE_MS, type SharedBrainDeps } from './user-runtime';

// Fresh in-memory Postgres (PGlite) with the real Drizzle migrations applied — MirrorStore/RugExitStore/EventStore
// run against the exact production schema (multi-tenant PKs included).
const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();

const log = pino({ level: 'silent' });
// ONE shared wallet + ONE watched leader for both runtimes — the exact Inc.3b topology (custody is Inc.4).
const OWNER = Keypair.generate().publicKey;
const LEADER = Keypair.generate().publicKey.toBase58();
const OPERATOR_FEE = Keypair.generate().publicKey.toBase58(); // Inc.4d fee sink (SPEC §9)
const USER_A = 'test-runtime-user-a';
const USER_B = 'test-runtime-user-b';

/** ONE SharedBrainDeps for BOTH runtimes (the production topology): anything leaking across users must come from a
 *  runtime bug, never from the test giving each runtime its own shared bag. I/O deps are inert fakes — the tests
 *  below exercise state isolation only, never a network/RPC path (a hit would throw loudly). */
const shared: SharedBrainDeps = {
  log,
  conn: new Connection('http://127.0.0.1:1'), // never called by the exercised surface
  db,
  bus: {
    publish: async () => {
      throw new Error('bus must not be hit by isolation tests');
    },
  } as unknown as RedisBus,
  hmacKey: 'test-hmac-key',
  poolReader: {
    // null for every pool EXCEPT the close-sell guard fixture: its (offline) meta lets onCloseExecuted resolve
    // the residual mint without RPC, so the in-flight-buy guard is reachable in isolation.
    loadPoolMeta: async (pool: string) =>
      pool === 'POOL_SELL_GUARD'
        ? ({
            solSide: 'Y',
            mintX: 'MINT_INFLIGHT',
            mintY: 'So11111111111111111111111111111111111111112',
          } as LoadedPoolMeta)
        : null,
  } as unknown as OnchainPoolMetaReader,
  tokenMeta: {} as HeliusTokenMetadataGateway,
  blockhashCache: new BlockhashCache(async () => ({ blockhash: 'x', lastValidBlockHeight: 0 })),
  priorityFeeOracle: { get: () => null } as unknown as PriorityFeeOracle,
  filterDeps: { jupiterToken: async () => null, snapshotCache: new TtlCache<TokenSnapshot>(1000) },
  control: {} as ControlChannel,
  heartbeat: {} as HeartbeatStore,
  recentlyPublishedClose: new Map(),
  inFlightBuyMints: new Map(),
  pendingSellMints: new Map(),
  walletBalanceCache: { balanceSol: async () => 10 }, // never hit by SYSTEM/constant-balance isolation tests
  nextJitoTipSeed: () => 0,
  jupiterBaseUrl: 'http://127.0.0.1:1',
  jitoEnabledEnv: undefined,
  priorityFeeOracleEnv: undefined,
  alertSink: undefined,
  operatorFeeAddress: OPERATOR_FEE,
  positionLedger: new PositionLedgerRepository(db),
  feeLedger: new FeeLedgerRepository(db),
};

const opts = {
  ownerPk: OWNER,
  balanceOf: async () => 10,
  leader: LEADER,
  initialConfig: CONFIG_DEFAULTS,
};
const rtA = await createUserRuntime(shared, USER_A, opts);
const rtB = await createUserRuntime(shared, USER_B, opts);

const LP = '__test_user_runtime_leader_pos__';

/** Poll a fire-and-forget write until `ready` (CopyEvents persists async — `emit` never awaits the insert). */
async function waitFor<T>(read: () => Promise<T>, ready: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (ready(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return read();
}

describe('createUserRuntime — two instances are FULLY isolated (Inc.3b S3)', () => {
  it('registry: a mirror opened in A is invisible to B (and vice versa untouched)', () => {
    // WHY: routing reads the runtime's OWN registry (`tracked` ⇒ resync, not open). A shared registry would make
    // user B see user A's mirror as "already tracked" and SILENTLY SKIP its own real-money copy of the same
    // leader position — and a close in A could flip B's mirror state.
    rtA.registry.open({
      leaderPosition: LP,
      leaderAddress: LEADER,
      ourPosition: 'OUR_A',
      pool: 'POOL',
      nonSolSymbol: 'TOK',
      nonSolMint: 'MINT',
      sizeSol: 0.2,
      lowerBin: -5,
      upperBin: 5,
      openedAt: Date.now(),
    });
    expect(rtA.registry.hasOpen(LP)).toBe(true);
    expect(rtB.registry.hasOpen(LP)).toBe(false);
  });

  it("caps read the runtime's own registry — A's exposure never consumes B's caps", () => {
    // WHY: capsState feeds checkCaps (max open positions / total exposure). If registries were shared, user A's
    // open positions would BLOCK user B's opens (a wrongly-skipped copy = a silent miss, the #1 forbidden failure).
    expect(rtA.capsState(LEADER, '').openPositions).toBe(1);
    expect(rtA.capsState(LEADER, '').leaderExposureSol).toBeCloseTo(0.2);
    expect(rtB.capsState(LEADER, '').openPositions).toBe(0);
    expect(rtB.capsState(LEADER, '').leaderExposureSol).toBe(0);
  });

  it('mirror store: rows are tenant-bound — A saveOpen is not loaded by B', async () => {
    // WHY: a cross-tenant loadOpen would make B's reconcile treat A's mirror as its own (mark it closed / re-close
    // it), corrupting both users' no-dormant guarantees after a restart.
    const m = rtA.registry.get(LP);
    if (!m) throw new Error('mirror missing');
    await rtA.store.saveOpen(m);
    expect((await rtA.store.loadOpen()).some((x) => x.leaderPosition === LP)).toBe(true);
    expect((await rtB.store.loadOpen()).some((x) => x.leaderPosition === LP)).toBe(false);
  });

  it('pending multi-tx-open maps are per-instance (disjoint), incl. the Token-2022 building grace map', () => {
    // WHY: the pending maps are keyed by commandId and drive the deferred continuations (buy→open, create→deposit)
    // + the cancel-on-leader-close logic. Module-level maps (the pre-3b layout) would let user A's
    // cancelPendingOpen drop user B's in-flight open — a silently-missed copy.
    const va = rtA.pendingOpenMapsView();
    const vb = rtB.pendingOpenMapsView();
    expect(va.twoSidedOpens).not.toBe(vb.twoSidedOpens);
    expect(va.token2022Deposits).not.toBe(vb.token2022Deposits);
    expect(va.token2022Mirrors).not.toBe(vb.token2022Mirrors);
    expect(va.reshapeAdds).not.toBe(vb.reshapeAdds);
    rtA.buildingToken2022Positions.set('POS_BUILDING', 123);
    expect(rtB.buildingToken2022Positions.has('POS_BUILDING')).toBe(false);
  });

  it('rug-exit sets are per-instance — A rug-exiting a position never suppresses B re-opens/re-closes', () => {
    // WHY: `rugExited` suppresses re-opening a leader position and `rugExitPending` drives retry-until-closed.
    // Shared sets would make user A's rug-SL exit silently block user B from copying that leader position (miss)
    // or make B's reconcile re-close a position it does not own.
    rtA.rugExited.add('LP_RUG');
    rtA.rugExitPending.add('OUR_RUG');
    expect(rtB.rugExited.has('LP_RUG')).toBe(false);
    expect(rtB.rugExitPending.has('OUR_RUG')).toBe(false);
  });

  it('commandIdFor: the SAME eventKey derives a DIFFERENT commandId per user (= deriveCommandId(userId, key))', () => {
    // WHY: one leader event copied for N users must claim N idempotency slots and N distinct ephemeral position
    // keypairs (SPEC §11 / Inc.3a). A collision would let user A's execution consume user B's claim → B's copy
    // silently never lands.
    const key = `${LEADER}:POOL:open:sig-1`;
    expect(rtA.commandIdFor(key)).not.toBe(rtB.commandIdFor(key));
    expect(rtA.commandIdFor(key)).toBe(deriveCommandId(USER_A, key));
    expect(rtB.commandIdFor(key)).toBe(deriveCommandId(USER_B, key));
  });

  it('emitter: each runtime stamps ITS OWN userId (bound context + persisted journal rows)', async () => {
    // WHY: the journal/feed is the user-facing audit trail — a row attributed to the wrong tenant leaks activity
    // across users and breaks the per-user feed. The context is bound ONCE at runtime construction.
    expect(rtA.events.context.userId).toBe(USER_A);
    expect(rtB.events.context.userId).toBe(USER_B);
    expect(rtA.events.context.wallet).toBe(OWNER.toBase58());
    rtA.events.emit('detect.routed', {
      stage: 'detect',
      outcome: 'detected',
      leader: LEADER,
      eventKey: 'iso-emit-a',
    });
    rtB.events.emit('detect.routed', {
      stage: 'detect',
      outcome: 'detected',
      leader: LEADER,
      eventKey: 'iso-emit-b',
    });
    const rows = await waitFor(
      () =>
        db
          .select({ userId: schema.copyJournal.userId, eventKey: schema.copyJournal.eventKey })
          .from(schema.copyJournal)
          .where(inArray(schema.copyJournal.eventKey, ['iso-emit-a', 'iso-emit-b'])),
      (r) => r.length === 2,
    );
    expect(rows.find((r) => r.eventKey === 'iso-emit-a')?.userId).toBe(USER_A);
    expect(rows.find((r) => r.eventKey === 'iso-emit-b')?.userId).toBe(USER_B);
  });

  it('SKIP journaling is per-user on the SHARED wallet: the same skipped open = TWO rows, keys fold the userId', async () => {
    // WHY (3b step 5): the durable journal dedup index is (wallet, correlationId, code) and every user shares ONE
    // wallet until Inc.4 — if two users' skip keys were identical, the second user's skip row would be silently
    // collapsed into the first's (a lost audit line). The key must also carry the EVENT's leader (threaded by the
    // hub), not the boot leader — this passes a different leader on purpose to prove the threading.
    const EVENT_LEADER = 'EventLeader11111111111111111111111111111111';
    const e = {
      signature: 'sig-skip-1',
      blockTime: 1,
      instruction: 'AddLiquidityByStrategy2',
      depositSol: 1,
      withdrawSol: 0,
      claimSol: 0,
      closed: false,
      pool: 'POOL_SKIP',
      position: '__test_skip_pos__',
      nonSolMint: null, // decideEntry skips 'non_sol_paired' BEFORE any RPC → fully offline path
      nonSolSymbol: null,
    };
    rtA.onEvent(e, 'ws', EVENT_LEADER, 1);
    rtB.onEvent(e, 'ws', EVENT_LEADER, 1);
    const keyA = `${USER_A}:${EVENT_LEADER}:POOL_SKIP:open-skip:sig-skip-1:__test_skip_pos__`;
    const keyB = `${USER_B}:${EVENT_LEADER}:POOL_SKIP:open-skip:sig-skip-1:__test_skip_pos__`;
    const rows = await waitFor(
      () =>
        db
          .select({ userId: schema.copyJournal.userId, eventKey: schema.copyJournal.eventKey })
          .from(schema.copyJournal)
          .where(inArray(schema.copyJournal.eventKey, [keyA, keyB])),
      (r) => r.length === 2,
    );
    expect(rows.find((r) => r.eventKey === keyA)?.userId).toBe(USER_A);
    expect(rows.find((r) => r.eventKey === keyB)?.userId).toBe(USER_B);
  });

  it("config is per-instance — setConfig on A never changes B's effective config", () => {
    // WHY: reloadConfig applies per-user rows (kill switch, stop-closes). A shared config reference would let one
    // user's stop/kill-switch silently halt (or re-enable) every other user's trading.
    rtA.setConfig({
      ...CONFIG_DEFAULTS,
      user: { ...CONFIG_DEFAULTS.user, enabled: !CONFIG_DEFAULTS.user.enabled },
    });
    expect(rtA.getConfig().user.enabled).toBe(!CONFIG_DEFAULTS.user.enabled);
    expect(rtB.getConfig().user.enabled).toBe(CONFIG_DEFAULTS.user.enabled);
  });
});

describe('UserRuntime — fan-out ownership accessors (Inc.3b S5)', () => {
  const LP2 = '__test_own_leader_pos__';

  it('ownsLeaderPosition: true for an OPEN mirror, false for the other runtime (owner-union must not over-target)', () => {
    // WHY: the hub unions "owners" into an event's targets so a CLOSE reaches a user whose leader was stopped
    // mid-flight — but over-claiming would deliver other users' events to a runtime that must not act on them.
    rtB.registry.open({
      leaderPosition: LP2,
      leaderAddress: LEADER,
      ourPosition: 'OUR_B2',
      pool: 'POOL',
      nonSolSymbol: null,
      nonSolMint: 'MINT',
      sizeSol: 0.1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: Date.now(),
    });
    expect(rtB.ownsLeaderPosition(LP2)).toBe(true);
    expect(rtA.ownsLeaderPosition(LP2)).toBe(false);
  });

  it('ownsLeaderPosition: true while an in-flight multi-tx open STASH holds the position (close must cancel it)', () => {
    // WHY: a leader close during a buy→open gap must reach the runtime whose continuation is in flight — the
    // pending stash is that runtime's only claim on the position (registry.open has not run yet).
    const LP3 = '__test_own_stash_pos__';
    const stash = rtA.pendingOpenMapsView().twoSidedOpens as Map<
      string,
      { e: { position: string; pool: string } }
    >;
    stash.set('CMD_STASH', { e: { position: LP3, pool: 'POOL' } });
    expect(rtA.ownsLeaderPosition(LP3)).toBe(true);
    expect(rtA.ownsCommand('CMD_STASH')).toBe(true); // ev:executed continuation routes by this claim
    expect(rtB.ownsLeaderPosition(LP3)).toBe(false);
    stash.delete('CMD_STASH');
    expect(rtA.ownsLeaderPosition(LP3)).toBe(false);
  });

  it('ownsOurPosition: mirror row (even closed) + pending rug-exit both claim the confirm routing', () => {
    // WHY: a close confirm can arrive AFTER registry.close flipped the row, and a rug-SL retry entry can outlive
    // its mirror — both must still route the ev:executed close to THIS runtime (purge + markClosed idempotent).
    expect(rtB.ownsOurPosition('OUR_B2')).toBe(true);
    rtB.registry.close(LP2);
    expect(rtB.ownsOurPosition('OUR_B2')).toBe(true); // the row survives a close (status flip, not delete)
    rtA.rugExitPending.add('OUR_RUG_ROUTE');
    expect(rtA.ownsOurPosition('OUR_RUG_ROUTE')).toBe(true);
    expect(rtB.ownsOurPosition('OUR_RUG_ROUTE')).toBe(false);
  });

  it('leaderHoldings: open mirrors attribute their leader; an unattributable rug-pending yields null (retain)', () => {
    // WHY: shouldRetainLeader keeps a drained leader's detector alive from exactly this view — a mis-attributed
    // holding would let the hub drop a leader whose mirror can still close (the forbidden miss).
    const holdingsA = rtA.leaderHoldings();
    expect(holdingsA.openMirrorLeaders).toContain(LEADER); // rtA's mirror from the isolation suite above
    expect(holdingsA.rugExitPendingLeaders).toContain(null); // OUR_RUG_ROUTE has no mirror row → unattributable
  });
});

describe('UserRuntime — close-sell respects the shared inFlightBuyMints grace (Inc.3b S6)', () => {
  const POOL = 'POOL_SELL_GUARD';
  const MINT = 'MINT_INFLIGHT'; // the pool fixture's non-SOL leg (solSide 'Y' ⇒ token = mintX)

  it("a close confirm during ANOTHER user's in-flight two-sided buy DEFERS the residual sell (no read, no publish)", async () => {
    // WHY: the sell reads the WHOLE shared-wallet balance of the mint — user A's close-sell firing while user B's
    // buy→deposit is in flight would sell B's just-bought token leg out from under their open (cross-user capital
    // loss). Within the grace the handler must return BEFORE any RPC/publish; the fake conn/bus would throw loudly
    // if it did not (this resolving cleanly IS the proof).
    shared.inFlightBuyMints.set(MINT, Date.now());
    try {
      await expect(
        rtA.onCloseExecuted({ pool: POOL, positionPubkey: 'OUR_X' }),
      ).resolves.toBeUndefined();
    } finally {
      shared.inFlightBuyMints.delete(MINT);
    }
  });

  it('past the grace the sell path proceeds (the guard releases — the residue is not deferred forever)', async () => {
    // WHY: the guard must be a DELAY, not a mute — a still-present token past the grace is a real residual. Past
    // the grace the handler reaches the wallet balance read, which the offline test conn rejects: the rejection
    // proves the guard released (in-grace above resolves without ever touching the conn).
    shared.inFlightBuyMints.set(MINT, Date.now() - (INFLIGHT_BUY_GRACE_MS + 1));
    try {
      await expect(rtA.onCloseExecuted({ pool: POOL, positionPubkey: 'OUR_X' })).rejects.toThrow();
    } finally {
      shared.inFlightBuyMints.delete(MINT);
    }
  });
});

describe('UserRuntime — per-user opens-per-window ring (Inc.3b S8)', () => {
  it("restoreOpenMirrors seeds ONE user's ring; the other user's window stays untouched", () => {
    // WHY: caps.maxOpensPerWindow is a PER-USER rate limit — user A's open burst consuming user B's window would
    // silently skip B's legitimate copies (a miss). The ring lives inside the runtime instance by construction.
    const T0 = Date.now();
    const baselineA = rtA.capsState(LEADER, '').openTimestampsMs.length;
    const baselineB = rtB.capsState(LEADER, '').openTimestampsMs.length;
    const m = (i: number) => ({
      leaderPosition: `__ring_lp_${i}__`,
      leaderAddress: LEADER,
      ourPosition: `__ring_our_${i}__`,
      pool: 'POOL_RING',
      nonSolSymbol: null,
      nonSolMint: 'MINT',
      sizeSol: 0.1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: T0,
    });
    rtA.restoreOpenMirrors([m(1), m(2)]);
    const ringA = rtA.capsState(LEADER, '').openTimestampsMs;
    expect(ringA.length).toBe(baselineA + 2);
    expect(ringA).toContain(T0); // seeded from the persisted openedAt, not re-stamped
    expect(rtB.capsState(LEADER, '').openTimestampsMs.length).toBe(baselineB);

    // The wired consequence: A's window can block while B's identical check allows.
    const caps = { ...CONFIG_DEFAULTS.user.caps, maxOpensPerWindow: 2, windowMinutes: 10 };
    expect(checkCaps(caps, rtA.capsState(LEADER, ''), 0.1, T0 + 1).action).toBe('block');
    expect(checkCaps(caps, rtB.capsState(LEADER, ''), 0.1, T0 + 1).action).toBe('allow');
  });

  it('an idempotent re-open of the SAME leader position records NO new window entry', () => {
    // WHY: the ring counts OPENS; a duplicate registry.open no-op (replayed restore, double confirm) burning
    // window budget would starve real copies behind phantom ones.
    const T0 = Date.now();
    const m = {
      leaderPosition: '__ring_dup_lp__',
      leaderAddress: LEADER,
      ourPosition: '__ring_dup_our__',
      pool: 'POOL_RING',
      nonSolSymbol: null,
      nonSolMint: 'MINT',
      sizeSol: 0.1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: T0,
    };
    const before = rtB.capsState(LEADER, '').openTimestampsMs.length;
    rtB.restoreOpenMirrors([m, m]); // second entry is the SAME open leader position → no-op
    expect(rtB.capsState(LEADER, '').openTimestampsMs.length).toBe(before + 1);
  });
});

describe('UserRuntime — Inc.4d performance-fee collection (SPEC §9)', () => {
  const FEE_USER = 'test-runtime-fee-user';
  const positionLedgerRepo = new PositionLedgerRepository(db);
  const feeLedgerRepo = new FeeLedgerRepository(db);

  /** Seed a COMPLETE per-position ledger for `ourPosition` under `FEE_USER` (as the confirm worker would). */
  async function seedLedger(
    ourPosition: string,
    legs: Array<{ kind: string; lamportsIn?: number; lamportsOut?: number }>,
  ): Promise<void> {
    let i = 0;
    for (const leg of legs)
      await positionLedgerRepo.append({
        userId: FEE_USER,
        ourPosition,
        kind: leg.kind,
        lamportsIn: leg.lamportsIn ?? 0,
        lamportsOut: leg.lamportsOut ?? 0,
        sig: `${ourPosition}-${i++}`,
        confirmedAt: Date.now(),
      });
  }

  // A valid 32-byte base58 blockhash (any pubkey) so publishFee's tx.serialize() succeeds — the coffre re-sets a
  // fresh blockhash before signing, so the placeholder value is irrelevant to correctness.
  const FEE_BLOCKHASH = Keypair.generate().publicKey.toBase58();

  /** A runtime for FEE_USER whose bus CAPTURES published SignRequests (so we can decode a fee transfer). */
  async function feeRuntime(operatorFeeAddress = OPERATOR_FEE) {
    const published: Array<Record<string, unknown>> = [];
    const bus = {
      publish: async (_s: string, _h: string, _k: string, payload: Record<string, unknown>) => {
        published.push(payload);
        return 'sid';
      },
    } as unknown as RedisBus;
    const blockhashCache = new BlockhashCache(async () => ({
      blockhash: FEE_BLOCKHASH,
      lastValidBlockHeight: 0,
    }));
    await blockhashCache.start();
    // publishFee reads the current slot for the SignRequest freshness bounds — a minimal offline stub.
    const conn = { getSlot: async () => 0 } as unknown as Connection;
    const rt = await createUserRuntime(
      { ...shared, bus, blockhashCache, conn, operatorFeeAddress },
      FEE_USER,
      opts,
    );
    return { rt, published };
  }

  it('close-confirm on a WINNING position assesses 5% → one pending fee_ledger row + a fee.assessed feed event', async () => {
    // WHY: the fee is real revenue levied at close from the bot's OWN ledger; a winner owes exactly floor(5%),
    // recorded once (idempotent) and shown transparently in the feed (SPEC §9).
    const OUR = 'OUR_FEE_WIN';
    // deposit 1.0, close 1.5 → base 0.5 SOL → fee 0.025 SOL.
    await seedLedger(OUR, [
      { kind: 'open', lamportsOut: 1_000_000_000 },
      { kind: 'close', lamportsIn: 1_500_000_000 },
    ]);
    const { rt } = await feeRuntime();
    rt.registry.open({
      leaderPosition: 'LP_FEE_WIN',
      leaderAddress: LEADER,
      ourPosition: OUR,
      pool: 'POOL',
      nonSolSymbol: null,
      nonSolMint: 'MINT',
      sizeSol: 1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: Date.now(),
    });
    await rt.onCloseConfirmed(OUR);
    const rows = await db
      .select()
      .from(schema.feeLedger)
      .where(inArray(schema.feeLedger.ourPosition, [OUR]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'pending',
      basePnlLamports: 500_000_000,
      feeLamports: 25_000_000,
    });
    const feed = await waitFor(
      () =>
        db
          .select()
          .from(schema.copyJournal)
          .where(inArray(schema.copyJournal.code, ['fee.assessed'])),
      (r) => r.length > 0,
    );
    expect(feed.some((f) => f.ourPosition === OUR)).toBe(true);
  });

  it('a LOSING position owes NOTHING — no fee_ledger row, no fee event', async () => {
    const OUR = 'OUR_FEE_LOSS';
    await seedLedger(OUR, [
      { kind: 'open', lamportsOut: 1_000_000_000 },
      { kind: 'close', lamportsIn: 400_000_000 }, // base −0.6 SOL
    ]);
    const { rt } = await feeRuntime();
    rt.registry.open({
      leaderPosition: 'LP_FEE_LOSS',
      leaderAddress: LEADER,
      ourPosition: OUR,
      pool: 'POOL',
      nonSolSymbol: null,
      nonSolMint: 'MINT',
      sizeSol: 1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: Date.now(),
    });
    await rt.onCloseConfirmed(OUR);
    const rows = await db
      .select()
      .from(schema.feeLedger)
      .where(inArray(schema.feeLedger.ourPosition, [OUR]));
    expect(rows).toHaveLength(0);
  });

  it('a second close-confirm is idempotent — still exactly ONE fee row (no double-charge)', async () => {
    const OUR = 'OUR_FEE_IDEM';
    await seedLedger(OUR, [
      { kind: 'open', lamportsOut: 1_000_000_000 },
      { kind: 'close', lamportsIn: 2_000_000_000 },
    ]);
    const { rt } = await feeRuntime();
    const mirror = {
      leaderPosition: 'LP_FEE_IDEM',
      leaderAddress: LEADER,
      ourPosition: OUR,
      pool: 'POOL',
      nonSolSymbol: null,
      nonSolMint: 'MINT',
      sizeSol: 1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: Date.now(),
    };
    rt.registry.open(mirror);
    await rt.onCloseConfirmed(OUR);
    rt.registry.open(mirror); // re-register (as a reconcile re-drive might) and confirm again
    await rt.onCloseConfirmed(OUR);
    const rows = await db
      .select()
      .from(schema.feeLedger)
      .where(inArray(schema.feeLedger.ourPosition, [OUR]));
    expect(rows).toHaveLength(1);
  });

  it('publishFee builds a kind:fee SystemProgram.transfer to the OPERATOR sink for the exact lamports', async () => {
    // WHY: the coffre re-verifies the fee tx moves SOL to its OWN operator sink — the brain must build exactly
    // that transfer (owner → operator, feeLamports) under a kind:'fee' SignRequest with the traceability payload.
    const { rt, published } = await feeRuntime();
    await rt.publishFee('OUR_FEE_PUB', 40_000_000);
    expect(published).toHaveLength(1);
    const sr = published[0]!;
    expect(sr.kind).toBe('fee');
    expect(sr.owner).toBe(OWNER.toBase58());
    expect(sr.fee).toEqual({ toAddress: OPERATOR_FEE, lamports: '40000000' });
    // Decode the unsigned tx: exactly one SystemProgram.transfer of 40_000_000 lamports owner → operator.
    const tx = Transaction.from(Buffer.from(sr.txBase64 as string, 'base64'));
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.keys[0]?.pubkey.toBase58()).toBe(OWNER.toBase58()); // from = owner
    expect(ix.keys[1]?.pubkey.toBase58()).toBe(OPERATOR_FEE); // to = operator sink
    expect(ix.data.readBigUInt64LE(4)).toBe(40_000_000n); // SystemProgram.transfer lamports (offset 4)
  });

  it('publishFee is a NO-OP when no operator sink is configured (nothing to transfer)', async () => {
    const { rt, published } = await feeRuntime('');
    await rt.publishFee('OUR_FEE_NOSINK', 10_000_000);
    expect(published).toHaveLength(0);
  });

  it('a bus.publish FAILURE still journals the intent (loud) + re-throws — never a silent dropped command (ULTRACODE #42)', async () => {
    // WHY: the journal emit historically sat AFTER bus.publish inside publish(), so a throwing publish dropped a live
    // open/resync/claim with ONLY a log line — no audit row, no loud signal (the never-miss pillar is for opens too,
    // and only closes are backstopped by the reconcile). ioredis already retries connection blips, so a genuine throw
    // must (a) leave an error-severity `lifecycle.publish_failed` journal row and (b) PROPAGATE so the caller never
    // treats an unpublished command as sent. publishFee routes through the SAME publish() closure every intent uses.
    const bus = {
      publish: async () => {
        throw new Error('redis down at publish');
      },
    } as unknown as RedisBus;
    const blockhashCache = new BlockhashCache(async () => ({
      blockhash: FEE_BLOCKHASH,
      lastValidBlockHeight: 0,
    }));
    await blockhashCache.start();
    const conn = { getSlot: async () => 0 } as unknown as Connection;
    const rt = await createUserRuntime(
      { ...shared, bus, blockhashCache, conn, operatorFeeAddress: OPERATOR_FEE },
      'test-runtime-pubfail-user',
      opts,
    );
    const OUR = 'OUR_PUBFAIL';
    // (b) fail loud — the publish failure propagates to the caller, never swallowed.
    await expect(rt.publishFee(OUR, 1_000_000)).rejects.toThrow('redis down at publish');
    // (a) ...and the intent is journaled DESPITE the failed publish, as a LOUD error-severity row.
    const [row] = await waitFor(
      () =>
        db
          .select({
            code: schema.copyJournal.code,
            severity: schema.copyJournal.severity,
            outcome: schema.copyJournal.outcome,
          })
          .from(schema.copyJournal)
          .where(inArray(schema.copyJournal.eventKey, [`fee:${OUR}`])),
      (r) => r.length > 0,
    );
    expect(row?.code).toBe('lifecycle.publish_failed');
    expect(row?.outcome).toBe('failed');
    expect(row?.severity).toBe('error');
  });

  it('onFeeConfirmed flips the fee landed + emits fee.landed once (a duplicate confirm is a no-op)', async () => {
    const OUR = 'OUR_FEE_LAND';
    const { rt } = await feeRuntime();
    await feeLedgerRepo.assess(FEE_USER, OUR, 500_000_000, 25_000_000, 'pending');
    await rt.onFeeConfirmed({ positionPubkey: OUR, sig: 'FEE_LAND_SIG' });
    await rt.onFeeConfirmed({ positionPubkey: OUR, sig: 'FEE_LAND_SIG' }); // duplicate → no second feed row
    const [row] = await db
      .select()
      .from(schema.feeLedger)
      .where(inArray(schema.feeLedger.ourPosition, [OUR]));
    expect(row).toMatchObject({ state: 'landed', sig: 'FEE_LAND_SIG' });
    const feed = await waitFor(
      () =>
        db
          .select()
          .from(schema.copyJournal)
          .where(inArray(schema.copyJournal.ourPosition, [OUR])),
      (r) => r.some((f) => f.code === 'fee.landed'),
    );
    expect(feed.filter((f) => f.code === 'fee.landed')).toHaveLength(1);
  });
});

describe('UserRuntime — per-user, per-token concurrency cap (ULTRACODE #9)', () => {
  // Distinct from every other test's 'MINT' so this suite counts only its own seeded mirrors (shared rtA/rtB).
  const MINT_PT = 'MintPerTokenxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const OTHER_MINT = 'MintOtherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const mk = (i: number, mint: string) => ({
    leaderPosition: `__pt_lp_${i}__`,
    leaderAddress: LEADER,
    ourPosition: `__pt_our_${i}__`,
    pool: 'POOL_PT',
    nonSolSymbol: null,
    nonSolMint: mint,
    sizeSol: 0.1,
    lowerBin: -1,
    upperBin: 1,
    openedAt: Date.now(),
  });

  it("counts THIS user's open mirrors of the candidate mint (a different/empty mint counts 0)", () => {
    // WHY: maxConcurrentPerToken means "at most N open positions in the SAME token". The count MUST key off the
    // mirror's persisted nonSolMint — before this fix it was hardcoded 0, so the cap could NEVER fire (dead guardrail).
    rtA.registry.open(mk(1, MINT_PT)); // idempotent by leaderPosition → safe to (re)open in each test
    rtA.registry.open(mk(2, MINT_PT));
    expect(rtA.capsState(LEADER, MINT_PT).tokenOpenCount).toBe(2);
    expect(rtA.capsState(LEADER, OTHER_MINT).tokenOpenCount).toBe(0);
    // An empty candidate mint (a non-SOL pool, skipped later anyway) matches nothing — not even a legacy '' mirror.
    expect(rtA.capsState(LEADER, '').tokenOpenCount).toBe(0);
  });

  it('blocks a further open of a token already at maxConcurrentPerToken; a different token is allowed', () => {
    rtA.registry.open(mk(1, MINT_PT));
    rtA.registry.open(mk(2, MINT_PT));
    const caps = { ...CONFIG_DEFAULTS.user.caps, maxConcurrentPerToken: 2 };
    const blocked = checkCaps(caps, rtA.capsState(LEADER, MINT_PT), 0.1, Date.now());
    expect(blocked).toMatchObject({ action: 'block', reason: 'max_concurrent_per_token' });
    // A candidate in a DIFFERENT token (0 open) is allowed — the cap is per token, not global.
    expect(checkCaps(caps, rtA.capsState(LEADER, OTHER_MINT), 0.1, Date.now()).action).toBe(
      'allow',
    );
  });

  it('the DEFAULT (maxConcurrentPerToken null) never blocks, even with the token fully seeded', () => {
    // WHY: the count is now computed on every open, but the cap must stay INERT unless configured — the SOL-only
    // fast path's behavior is unchanged for the default config (no new block, no behavior drift).
    rtA.registry.open(mk(1, MINT_PT));
    rtA.registry.open(mk(2, MINT_PT));
    expect(CONFIG_DEFAULTS.user.caps.maxConcurrentPerToken).toBeNull();
    expect(
      checkCaps(CONFIG_DEFAULTS.user.caps, rtA.capsState(LEADER, MINT_PT), 0.1, Date.now()).action,
    ).toBe('allow');
  });

  it('the per-token count is PER USER — user B in the same token is not counted for user A budgeting', () => {
    // WHY: both tenants share the leader stream; A's positions in a token must never consume B's per-token budget.
    rtA.registry.open(mk(1, MINT_PT));
    rtA.registry.open(mk(2, MINT_PT));
    expect(rtB.capsState(LEADER, MINT_PT).tokenOpenCount).toBe(0);
  });
});

describe('UserRuntime — a leader position wider than one DLMM position skips typed, never crashes (ULTRACODE #18)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const WIDE_POOL = Keypair.generate().publicKey.toBase58(); // must be a valid base58 pubkey (handleOpen does new PublicKey(e.pool))
  const WIDE_MINT = Keypair.generate().publicKey.toBase58();

  it('a >70-bin one-sided open emits eligibility.too_wide and does NOT publish (no generic mirror error)', async () => {
    // WHY (copy-fidelity + fail-loud): a leader position spanning more bins than one DLMM position can't be
    // replicated as a single create + deposit. Before this fix the general open path threw a generic mirror error
    // with no eligibility row; it must instead emit the TYPED eligibility.too_wide skip and publish nothing.
    const publish = vi.fn(async () => undefined);
    const errs: unknown[] = [];
    const capturingLog = {
      info() {},
      warn() {},
      debug() {},
      error: (o: unknown) => errs.push(o),
      child() {
        return capturingLog;
      },
    };
    const sharedWide: SharedBrainDeps = {
      ...shared,
      log: capturingLog as never,
      bus: { publish } as unknown as RedisBus,
      poolReader: {
        loadPoolMeta: async (pool: string) =>
          pool === WIDE_POOL
            ? ({ solSide: 'Y', binStep: 20, mintX: WIDE_MINT, mintY: WSOL } as LoadedPoolMeta)
            : null,
      } as unknown as OnchainPoolMetaReader,
    };
    const rt = await createUserRuntime(sharedWide, 'wide-user', opts);

    // 71 contiguous bins (> MAX_SINGLE_POSITION_BINS = 70), SOL on the Y side. Both legs are populated so the
    // stable-shape read returns on the FIRST poll (no 1s retry sleep); twoSidedMode is 'off' by default, so
    // handleOpen still routes the general one-sided path (which reads the SOL/Y leg only).
    const perBin = Array.from({ length: 71 }, (_, i) => ({ binId: i - 35, x: 1n, y: 1_000n }));
    vi.mocked(readLeaderPositionShape).mockResolvedValue({
      positionPubkey: '__wide_pos__',
      activeBinId: 0,
      lowerBinId: -35,
      upperBinId: 35,
      perBin,
    });

    const e = {
      signature: 'sig-wide-1',
      blockTime: 1,
      instruction: 'AddLiquidityByStrategy2',
      depositSol: 1,
      depositTokenRaw: 0, // one-sided → the general (not Token-2022/two-sided) open path
      withdrawSol: 0,
      claimSol: 0,
      closed: false,
      pool: WIDE_POOL,
      position: '__wide_pos__',
      nonSolMint: WIDE_MINT,
      nonSolSymbol: 'WIDE',
    };
    // The event leader must be a CONFIGURED+enabled leader, else caps pause an unknown leader before the guard.
    const wideLeader = CONFIG_DEFAULTS.leaders[0]!.address;
    // Must not throw synchronously nor asynchronously (the guard returns cleanly).
    await expect(Promise.resolve(rt.onEvent(e, 'ws', wideLeader, 1))).resolves.not.toThrow();

    const rows = await waitFor(
      () =>
        db
          .select({ code: schema.copyJournal.code, userId: schema.copyJournal.userId })
          .from(schema.copyJournal)
          .where(inArray(schema.copyJournal.userId, ['wide-user'])),
      (r) => r.length > 0,
    );
    expect(rows.map((r) => r.code)).toContain('eligibility.too_wide');
    expect(publish).not.toHaveBeenCalled(); // never published an open (no partial/half copy)
    expect(errs).toEqual([]); // and NO generic mirror error was thrown/logged (the whole point of #18) (no partial/half copy)
  });
});

describe('UserRuntime — a transient getSlot() 429 on a filtered-skip open never crashes the brain (#138)', () => {
  it('a rejecting getSlot() on a skip path resolves handleOpen cleanly and emits NO process unhandledRejection', async () => {
    // WHY (#138, robustness pillar): handleOpen fires pairP/slotsP/filterDataP in PARALLEL, then several skip/return
    // paths (here the on-chain non-SOL guard) return WITHOUT awaiting them. slots() wraps conn.getSlot(); a 429 that
    // lands after the skip must be absorbed by the creation-time tee — never bubble to process 'unhandledRejection'
    // and take down the whole brain. This FAILS if that tee regresses: the un-awaited slotsP would go unhandled.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // A real Connection surface (nothing else on the skip path touches it) whose getSlot() rejects immediately and
      // deterministically — the transient 429 the leader-event burst would trigger against a rate-limited RPC.
      const conn = new Connection('http://127.0.0.1:1');
      vi.spyOn(conn, 'getSlot').mockRejectedValue(new Error('429 Too Many Requests'));
      const publish = vi.fn(async () => undefined);
      // The default poolReader returns null meta for an unknown pool ⇒ handleOpen hits the `!meta.solSide` skip AFTER
      // the three parallel reads are already in flight — exactly the window where an un-awaited slotsP would leak.
      const sharedReject: SharedBrainDeps = {
        ...shared,
        conn,
        bus: { publish } as unknown as RedisBus,
      };
      const rt = await createUserRuntime(sharedReject, 'slot-429-user-138', opts);
      // A configured+enabled leader so caps PASS and we reach the parallel-reads block (an unknown leader is paused
      // BEFORE slotsP is ever created, and the tee would never be exercised).
      const leader = CONFIG_DEFAULTS.leaders[0]!.address;
      const e = {
        signature: 'sig-138-slot-429',
        blockTime: 1,
        instruction: 'AddLiquidityByStrategy2',
        depositSol: 1,
        depositTokenRaw: 0,
        withdrawSol: 0,
        claimSol: 0,
        closed: false,
        pool: Keypair.generate().publicKey.toBase58(), // valid pubkey, unknown pool ⇒ null meta ⇒ non-SOL skip
        position: '__slot_429_pos__',
        nonSolMint: Keypair.generate().publicKey.toBase58(),
        nonSolSymbol: 'X429',
      };
      await expect(Promise.resolve(rt.onEvent(e, 'ws', leader, 1))).resolves.not.toThrow();
      // The skip path ran to its typed emit ⇒ slotsP has settled (rejected) by now.
      const rows = await waitFor(
        () =>
          db
            .select({ code: schema.copyJournal.code })
            .from(schema.copyJournal)
            .where(inArray(schema.copyJournal.userId, ['slot-429-user-138'])),
        (r) => r.length > 0,
      );
      // Flush one macrotask so any UNHANDLED rejection would have been reported by the runtime before we assert.
      await new Promise((r) => setTimeout(r, 0));
      expect(rows.map((r) => r.code)).toContain('eligibility.non_sol_paired'); // we DID exercise the intended skip
      expect(unhandled).toEqual([]); // …and the tee absorbed the 429 — the brain stays up
      expect(publish).not.toHaveBeenCalled(); // a skip never publishes an open
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('UserRuntime — a deferred continuation is NEVER dropped after our buy/deposit landed (finding #137)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';

  it('publishTwoSidedOpenAfterBuy: a TRANSIENT createDlmmPair failure after the buy landed KEEPS the stash + rejects (retryable — the open is not lost)', async () => {
    // WHY (money-critical, finding #137): our buy already swapped real SOL → token. If the deferred open throws on a
    // transient RPC 429, the pending stash must SURVIVE and the call must REJECT so the un-ACKed ev:executed message
    // re-runs the open on the next PEL drain. Deleting the stash BEFORE the fallible createDlmmPair (the pre-fix bug)
    // permanently dropped the open — the bought token was recoverable only by the wallet sweep, at a two-spread loss.
    const rt = await createUserRuntime(shared, 'retry-user-open-137', opts);
    const CMD = 'buy-cmd-137-open';
    const pool = Keypair.generate().publicKey.toBase58();
    // The view exposes ReadonlyMaps (read-only for callers); a test seeds the underlying real Map to stage the exact
    // post-buy state the ev:executed(buy) confirm hands to the continuation.
    const twoSidedOpens = rt.pendingOpenMapsView().twoSidedOpens as unknown as Map<string, unknown>;
    twoSidedOpens.set(CMD, {
      e: {
        signature: 'sig-137-open',
        blockTime: 1,
        instruction: 'AddLiquidityByStrategy2',
        depositSol: 1,
        depositTokenRaw: 0,
        withdrawSol: 0,
        claimSol: 0,
        closed: false,
        pool,
        position: 'LP_137_OPEN',
        nonSolMint: WSOL,
        nonSolSymbol: 'TKN',
      },
      leader: LEADER,
      dist: [{ binId: 0, x: 1n, y: 1n }],
      sizeLamports: 1_000n,
      solSide: 'Y',
      tokenMint: WSOL,
      sizeSol: 1,
      preBuyTokenRaw: 0n,
      expectedTokenRaw: 0n,
      buySlippageBps: 0,
    });

    // createDlmmPair is the first fallible RPC after the buy — make it fail transiently (a 429).
    vi.mocked(createDlmmPair).mockRejectedValueOnce(new Error('429 Too Many Requests'));

    await expect(rt.publishTwoSidedOpenAfterBuy(CMD)).rejects.toThrow('429');
    expect(twoSidedOpens.has(CMD)).toBe(true); // stash intact → the open is retried on the next PEL drain, never dropped
  });

  it('finalizeToken2022Open: a TRANSIENT saveOpen (DB) failure after the deposit landed KEEPS the stash + rejects; the retry persists the mirror + drops the stash', async () => {
    // WHY (money-critical, finding #137): the Token-2022 deposit already landed → capital is IN the pool. If persisting
    // the mirror hits a DB blip, the stash must SURVIVE and the call REJECT so the retry re-persists it — otherwise the
    // funded position stays UNTRACKED and the orphan-sweep force-closes it (the copy is lost). saveOpen is an
    // idempotent upsert, so re-running the whole tail is safe.
    const rt = await createUserRuntime(shared, 'retry-user-finalize-137', opts);
    const CMD = 'deposit-cmd-137-finalize';
    const ourPosition = Keypair.generate().publicKey.toBase58();
    const mirrors = rt.pendingOpenMapsView().token2022Mirrors as unknown as Map<string, unknown>;
    mirrors.set(CMD, {
      leaderPosition: 'LP_137_FIN',
      leader: LEADER,
      ourPosition,
      pool: Keypair.generate().publicKey.toBase58(),
      nonSolSymbol: 'TKN',
      nonSolMint: WSOL,
      sizeSol: 1,
      lower: -5,
      upper: 5,
      leaderSizeSol: 1,
    });

    const saveOpen = vi.spyOn(rt.store, 'saveOpen');
    saveOpen.mockRejectedValueOnce(new Error('db connection blip'));

    // 1) DB blip after the deposit landed → REJECT + stash INTACT (retryable — the funded deposit is not dropped).
    await expect(rt.finalizeToken2022Open(CMD)).rejects.toThrow('db connection blip');
    expect(mirrors.has(CMD)).toBe(true);

    // 2) The PEL retry re-runs it; saveOpen now succeeds (call-through) → RESOLVES, stash DROPPED, mirror persisted+loadable.
    await expect(rt.finalizeToken2022Open(CMD)).resolves.toBeUndefined();
    expect(mirrors.has(CMD)).toBe(false);
    const open = await rt.store.loadOpen();
    expect(open.map((m) => m.ourPosition)).toEqual([ourPosition]); // tracked open — never an untracked funded position
    saveOpen.mockRestore();
  });
});
