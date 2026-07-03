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
    expect(rtA.capsState(LEADER).openPositions).toBe(1);
    expect(rtA.capsState(LEADER).leaderExposureSol).toBeCloseTo(0.2);
    expect(rtB.capsState(LEADER).openPositions).toBe(0);
    expect(rtB.capsState(LEADER).leaderExposureSol).toBe(0);
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
    const baselineA = rtA.capsState(LEADER).openTimestampsMs.length;
    const baselineB = rtB.capsState(LEADER).openTimestampsMs.length;
    const m = (i: number) => ({
      leaderPosition: `__ring_lp_${i}__`,
      leaderAddress: LEADER,
      ourPosition: `__ring_our_${i}__`,
      pool: 'POOL_RING',
      nonSolSymbol: null,
      sizeSol: 0.1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: T0,
    });
    rtA.restoreOpenMirrors([m(1), m(2)]);
    const ringA = rtA.capsState(LEADER).openTimestampsMs;
    expect(ringA.length).toBe(baselineA + 2);
    expect(ringA).toContain(T0); // seeded from the persisted openedAt, not re-stamped
    expect(rtB.capsState(LEADER).openTimestampsMs.length).toBe(baselineB);

    // The wired consequence: A's window can block while B's identical check allows.
    const caps = { ...CONFIG_DEFAULTS.user.caps, maxOpensPerWindow: 2, windowMinutes: 10 };
    expect(checkCaps(caps, rtA.capsState(LEADER), 0.1, T0 + 1).action).toBe('block');
    expect(checkCaps(caps, rtB.capsState(LEADER), 0.1, T0 + 1).action).toBe('allow');
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
      sizeSol: 0.1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: T0,
    };
    const before = rtB.capsState(LEADER).openTimestampsMs.length;
    rtB.restoreOpenMirrors([m, m]); // second entry is the SAME open leader position → no-op
    expect(rtB.capsState(LEADER).openTimestampsMs.length).toBe(before + 1);
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
