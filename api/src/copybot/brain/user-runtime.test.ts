import { PGlite } from '@electric-sql/pglite';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { and, eq, inArray } from 'drizzle-orm';
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
import { CopybotPositionsRepository } from '@/infrastructure/persistence/copybot-positions-repository';
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
// sits AFTER the leader-shape read. Override JUST the RPC seams these tests touch (real for every other export):
// `createDlmmPair` (a discarded dummy — the guard returns before any build) and `readLeaderPositionShape` (driven
// per-test to a wide one-sided shape). `buildCloseTx` is a passthrough spy (defaults to the REAL impl, so behavior
// is unchanged) that the stop-close ordering test (#153) overrides ONCE to observe when publishSafetyClose enters
// its close-publish path. `buildRemovePartial`/`buildAddByWeight` are passthrough spies the RESYNC size tests
// (#143 shrink, #145 published-only sizing) override to drive/observe handleResync's remove and add build tails.
// No other test in this file calls any of these, so their behavior is unchanged.
vi.mock('@/infrastructure/solana/dlmm/dlmm-tx-builder', async (orig) => {
  const actual = await orig<typeof import('@/infrastructure/solana/dlmm/dlmm-tx-builder')>();
  return {
    ...actual,
    createDlmmPair: vi.fn(async () => ({}) as never),
    buildCloseTx: vi.fn(actual.buildCloseTx),
    buildRemovePartial: vi.fn(actual.buildRemovePartial),
    buildAddByWeight: vi.fn(actual.buildAddByWeight),
    // Passthrough spy: the #39 twoSidedMode=off tests assert buildOpenByWeight WAS reached (the SOL-only open path),
    // proving a one-sided/#144-fallthrough leader was copied SOL-only rather than skipped. Real behavior otherwise.
    buildOpenByWeight: vi.fn(actual.buildOpenByWeight),
  };
});
vi.mock('@/infrastructure/solana/dlmm/leader-position-reader', async (orig) => {
  const actual = await orig<typeof import('@/infrastructure/solana/dlmm/leader-position-reader')>();
  return { ...actual, readLeaderPositionShape: vi.fn() };
});
// Passthrough spies: every export keeps its REAL behavior; the #145 two-sided-resync tests override them — a
// rejection for the UNQUOTABLE-grow case, and resolved quotes for the deferred defer→record flow.
vi.mock('@/infrastructure/solana/jupiter/jupiter-swap-builder', async (orig) => {
  const actual =
    await orig<typeof import('@/infrastructure/solana/jupiter/jupiter-swap-builder')>();
  return {
    ...actual,
    getJupiterQuote: vi.fn(actual.getJupiterQuote),
    getJupiterBuyQuoteExactIn: vi.fn(actual.getJupiterBuyQuoteExactIn),
    buildJupiterSwapTx: vi.fn(actual.buildJupiterSwapTx),
  };
});
// Passthrough spy: only the #145 deferred two-sided GROW test overrides readOwnerTokenBalance (pre-buy 0 → settled).
vi.mock('@/infrastructure/solana/token-balance-reader', async (orig) => {
  const actual = await orig<typeof import('@/infrastructure/solana/token-balance-reader')>();
  return { ...actual, readOwnerTokenBalance: vi.fn(actual.readOwnerTokenBalance) };
});

import {
  buildAddByWeight,
  buildCloseTx,
  buildRemovePartial,
  createDlmmPair,
} from '@/infrastructure/solana/dlmm/dlmm-tx-builder';
import { readLeaderPositionShape } from '@/infrastructure/solana/dlmm/leader-position-reader';
import {
  buildJupiterSwapTx,
  getJupiterBuyQuoteExactIn,
  getJupiterQuote,
} from '@/infrastructure/solana/jupiter/jupiter-swap-builder';
import { readOwnerTokenBalance } from '@/infrastructure/solana/token-balance-reader';
import { runClosedFeeBackstop } from './fee-sweep';
import {
  createUserRuntime,
  INFLIGHT_BUY_GRACE_MS,
  SELL_COMMAND_EPOCH_MS,
  type SharedBrainDeps,
} from './user-runtime';

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
  filterDeps: {
    jupiterToken: async () => null,
    snapshotCache: new TtlCache<TokenSnapshot>(1000),
    mintExtensions: async () => null,
    transferFeeCache: new TtlCache<boolean>(1000),
  },
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

  it('leaderOfCommand: reads the STASH leader across all four continuation maps (#60 multi-leader alerts), undefined once gone', () => {
    // WHY (idx60): a deferred-continuation FAILURE (two-sided open / Token-2022 create·deposit / reshape add) alerts
    // with a leader label. The originating (fan-out) leader is threaded on the in-flight stash; this accessor reads it
    // so the brain's `.catch` emit names the REAL leader, not the demoted default (cfg.leader). It must cover ALL FOUR
    // continuation maps (a dropped map ⇒ a mislabelled alert), and return undefined once the continuation dropped the
    // stash so the brain falls back to cfg.leader. FAILS if the accessor stops reading .leader or omits a map.
    const view = rtA.pendingOpenMapsView();
    const seeds: [Map<string, unknown>, string][] = [
      [view.twoSidedOpens as unknown as Map<string, unknown>, 'CMD_TWO_60'],
      [view.token2022Deposits as unknown as Map<string, unknown>, 'CMD_DEP_60'],
      [view.token2022Mirrors as unknown as Map<string, unknown>, 'CMD_MIR_60'],
      [view.reshapeAdds as unknown as Map<string, unknown>, 'CMD_ADD_60'],
    ];
    const stashLeader = new Map<string, string>();
    for (const [map, cmd] of seeds) {
      const leader = Keypair.generate().publicKey.toBase58(); // a fan-out leader ≠ the runtime's boot/default leader
      expect(leader).not.toBe(LEADER);
      map.set(cmd, { leader });
      stashLeader.set(cmd, leader);
    }
    for (const [, cmd] of seeds) expect(rtA.leaderOfCommand(cmd)).toBe(stashLeader.get(cmd)); // real per-map leader
    expect(rtA.leaderOfCommand('CMD_MISSING_60')).toBeUndefined(); // no stash ⇒ caller falls back to cfg.leader
    for (const [map, cmd] of seeds) map.delete(cmd); // cleanup (shared rtA) — and the drop-then-undefined check below
    expect(rtA.leaderOfCommand('CMD_TWO_60')).toBeUndefined(); // dropped stash ⇒ undefined (terminal-failure emit path)
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

  it('a close-sell during an in-flight open whose deposit is still landing (re-stamped past the OLD 30s window) DEFERS (finding #96)', async () => {
    // WHY: a two-sided open is a MULTI-hop chain — under congestion the deposit lands ~100s after the buy, and the
    // brain RE-STAMPS this grace at each hop (buy-publish → deposit-publish). At 60s the pre-fix 30s window had
    // expired, so this close-sell would have sold the bought leg out from under the still-landing deposit → the open
    // aborts insufficient-funds and the leg is lost (two swap fees burned). The grace, raised to the multi-tx open
    // window, keeps deferring for the whole open. Resolving cleanly (no RPC on the fake conn) IS the proof; a regressed
    // grace < 60s would proceed to the wallet-balance read and reject. Binds to the real INFLIGHT_BUY_GRACE_MS.
    const DEPOSIT_INFLIGHT_AGE_MS = 60_000; // time since the deposit hop re-stamped it; > the pre-fix 30s, < the grace
    shared.inFlightBuyMints.set(MINT, Date.now() - DEPOSIT_INFLIGHT_AGE_MS);
    try {
      await expect(
        rtA.onCloseExecuted({ pool: POOL, positionPubkey: 'OUR_X' }),
      ).resolves.toBeUndefined();
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

  it('#140: close-CONFIRM no longer assesses; close-EXECUTED on a no-sell winner assesses 5% → one pending row + fee.assessed', async () => {
    // WHY: the fee is real revenue levied at close from the bot's OWN ledger; a winner owes exactly floor(5%),
    // recorded once (idempotent) + shown transparently (SPEC §9). #140 MOVED the trigger OFF onCloseConfirmed:
    // markClosed runs BEFORE the residual sell, so assessing there undercounts a two-sided winner still missing its
    // SELL row. A non-SOL (no-sell) pool — loadPoolMeta → null here — is ledger-complete at onCloseExecuted → THAT is
    // where it assesses now. This test locks BOTH halves of the move (confirm = silent, executed = assesses).
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
    // (a) onCloseConfirmed markCloses but does NOT assess (#140) — the ledger may still lack the sell row.
    await rt.onCloseConfirmed(OUR);
    expect(
      await db
        .select()
        .from(schema.feeLedger)
        .where(inArray(schema.feeLedger.ourPosition, [OUR])),
    ).toHaveLength(0);
    // (b) onCloseExecuted on a non-SOL (no-sell) pool → the ledger is complete → assess NOW.
    await rt.onCloseExecuted({ pool: 'POOL', positionPubkey: OUR });
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
    await rt.onCloseExecuted({ pool: 'POOL', positionPubkey: OUR }); // #140 — no-sell pool → assess trigger
    const rows = await db
      .select()
      .from(schema.feeLedger)
      .where(inArray(schema.feeLedger.ourPosition, [OUR]));
    expect(rows).toHaveLength(0);
  });

  it('a second close-EXECUTED (PEL re-delivery) is idempotent — still exactly ONE fee row (no double-charge)', async () => {
    // WHY: the ev:executed(close) can be re-delivered (transient throw / restart), so onCloseExecuted's assess must
    // never double-charge — feeLedger.assess is idempotent on (userId, ourPosition). This is the SAME guarantee the
    // sell-confirm path and the periodic backstop lean on to co-exist without ever charging a position twice.
    const OUR = 'OUR_FEE_IDEM';
    await seedLedger(OUR, [
      { kind: 'open', lamportsOut: 1_000_000_000 },
      { kind: 'close', lamportsIn: 2_000_000_000 },
    ]);
    const { rt } = await feeRuntime();
    await rt.onCloseExecuted({ pool: 'POOL', positionPubkey: OUR });
    await rt.onCloseExecuted({ pool: 'POOL', positionPubkey: OUR }); // re-delivered close → assess again
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
      recordedSizeSol: 1, // combined (SOL leg + buy spend) → the persisted mirror's sizeSol (#94 §3)
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

describe('UserRuntime — a multi-tx open RE-ARMS the duplicate-open reservation at each continuation hop (#136)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';

  it('publishTwoSidedOpenAfterBuy re-arms pendingOpens for the leader position (a mid-chain add cannot route to a 2nd open even if the route-time reservation lapsed)', async () => {
    // WHY (money-critical, #136): the route-time reservation is TTL-bounded (OPEN_PENDING_TTL_MS). A slow multi-tx
    // open — buy retried under congestion, deposit still to build/land — can outlast it; if it lapses mid-chain a
    // leader ADD to the SAME position would route to a SECOND real-money open. Each open-continuation hop must
    // RE-STAMP the reservation so the TTL bounds ONE hop, not the whole chain. This drives the buy-landed hop and
    // proves it re-armed the reservation — it FAILS if `pendingOpens.reserve(e.position)` is removed from that hop.
    const rt = await createUserRuntime(shared, 'rearm-buy-136', opts);
    const CMD = 'buy-cmd-136-rearm';
    const LP = 'LP_136_REARM_BUY';
    const pool = Keypair.generate().publicKey.toBase58();
    const twoSidedOpens = rt.pendingOpenMapsView().twoSidedOpens as unknown as Map<string, unknown>;
    twoSidedOpens.set(CMD, {
      e: {
        signature: 'sig-136-buy',
        blockTime: 1,
        instruction: 'AddLiquidityByStrategy2',
        depositSol: 1,
        depositTokenRaw: 0,
        withdrawSol: 0,
        claimSol: 0,
        closed: false,
        pool,
        position: LP,
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
    // Fail the FIRST post-buy RPC so the hop exits right after the re-arm (which runs before createDlmmPair) — no
    // need to mock the whole build/publish tail. The 429 is retryable, so the stash is KEPT (the open is not lost).
    vi.mocked(createDlmmPair).mockRejectedValueOnce(new Error('429 Too Many Requests'));
    await expect(rt.publishTwoSidedOpenAfterBuy(CMD)).rejects.toThrow('429');

    // Isolate the reservation from the stash: drop the (retained) stash entry so the ONLY thing that can still make
    // the runtime OWN LP is the re-armed pendingOpens reservation (registry.open never ran ⇒ hasOpen is false).
    twoSidedOpens.delete(CMD);
    expect(rt.ownsLeaderPosition(LP)).toBe(true); // re-armed ⇒ a follow-up add on LP routes as tracked, never a 2nd open
    expect(rt.ownsLeaderPosition('LP_136_UNTOUCHED')).toBe(false); // per-position: a genuine new open elsewhere is NOT suppressed
  });

  it('publishDepositAfterPositionCreated re-arms pendingOpens for the leader position (the create→deposit hop is bounded too)', async () => {
    // WHY (#136): the second hop — create landed, deposit still to publish/land — must also re-stamp the reservation,
    // or a chain that already spent its TTL on the buy hop would lapse here. Drive it to the first post-hop RPC
    // (getSlot) and prove the reservation is armed. FAILS if the re-arm in this hop is removed. nonSolMint is null
    // (a one-sided wide open has NO bought token) to prove the re-arm is unconditional, unlike the bought-token grace.
    const conn = new Connection('http://127.0.0.1:1');
    vi.spyOn(conn, 'getSlot').mockRejectedValue(new Error('getSlot 429'));
    const rt = await createUserRuntime({ ...shared, conn }, 'rearm-deposit-136', opts);
    const CMD = 'create-cmd-136-rearm';
    const LP = 'LP_136_REARM_DEPOSIT';
    const pool = Keypair.generate().publicKey.toBase58();
    const deposits = rt.pendingOpenMapsView().token2022Deposits as unknown as Map<string, unknown>;
    deposits.set(CMD, {
      e: {
        signature: 'sig-136-deposit',
        blockTime: 1,
        instruction: 'AddLiquidityByStrategy2',
        depositSol: 1,
        depositTokenRaw: 0,
        withdrawSol: 0,
        claimSol: 0,
        closed: false,
        pool,
        position: LP,
        nonSolMint: null,
        nonSolSymbol: null,
      },
      leader: LEADER,
      lower: -5,
      upper: 5,
      sizeSol: 1,
      recordedSizeSol: 1,
      prebuiltDeposit: new Transaction(), // SPLIT path ⇒ no createDlmmPair/buildAddByWeight; exits at getSlot before serialize
    });
    await expect(rt.publishDepositAfterPositionCreated(CMD)).rejects.toThrow('getSlot 429');

    deposits.delete(CMD); // isolate the reservation from the stash (see above)
    expect(rt.ownsLeaderPosition(LP)).toBe(true); // re-armed at the create→deposit hop
    expect(rt.ownsLeaderPosition('LP_136_UNTOUCHED')).toBe(false);
  });
});

describe('UserRuntime — #140 two-sided fee completeness (buy + sell ledger rows, deferred assess, backstop)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const positionLedgerRepo = new PositionLedgerRepository(db);
  const positionsRepo = new CopybotPositionsRepository(db);

  /** Seed a per-position ledger under `userId` (as the confirm worker / open path would). */
  async function seed(
    userId: string,
    ourPosition: string,
    legs: Array<{ kind: string; in?: number; out?: number; sig?: string }>,
  ): Promise<void> {
    let i = 0;
    for (const l of legs)
      await positionLedgerRepo.append({
        userId,
        ourPosition,
        kind: l.kind,
        lamportsIn: l.in ?? 0,
        lamportsOut: l.out ?? 0,
        sig: l.sig ?? `${ourPosition}-seed-${i++}`,
        confirmedAt: Date.now(),
      });
  }

  /** A runtime whose conn.getTransaction returns a sell tx crediting the owner `deltaRef.v` lamports (the sell
   *  proceeds). `setSellDelta` mutates that delta between onSellConfirmed calls (models the shared-wallet drain). */
  async function mkRuntime(userId: string) {
    const deltaRef = { v: 0 };
    const conn = {
      getSlot: async () => 0,
      getTransaction: async () => ({
        meta: { preBalances: [1_000_000_000], postBalances: [1_000_000_000 + deltaRef.v] },
        transaction: { message: { staticAccountKeys: [{ toBase58: () => OWNER.toBase58() }] } },
      }),
    } as unknown as Connection;
    const rt = await createUserRuntime(
      { ...shared, conn, operatorFeeAddress: OPERATOR_FEE },
      userId,
      opts,
    );
    return {
      rt,
      setSellDelta: (v: number) => {
        deltaRef.v = v;
      },
    };
  }

  const ledgerRows = (userId: string, ourPosition: string) =>
    db
      .select()
      .from(schema.positionLedger)
      .where(
        and(
          eq(schema.positionLedger.userId, userId),
          eq(schema.positionLedger.ourPosition, ourPosition),
        ),
      );
  const feeRows = (ourPosition: string) =>
    db
      .select()
      .from(schema.feeLedger)
      .where(inArray(schema.feeLedger.ourPosition, [ourPosition]));

  it('WORKED EXAMPLE: 0.5 SOL leg + 0.5 buy, token pumps, close-sell 0.6 → SELL row appended + fee base = +0.07 SOL', async () => {
    // WHY (#140 end-to-end): the sell-confirm completes the ledger and assesses the DEFERRED fee. The base is
    // (close 0.47 + sell 0.6) − (open 0.5 + buy 0.5) = +0.07 SOL → fee = floor(5% · 0.07) = 0.0035 SOL. NOT +0.57
    // (missing the buy → over-charge) and NOT −0.53 (assessed before the sell → false loser, fee 0).
    const U = 'fee140-worked';
    const OUR = 'OUR_WORKED';
    await seed(U, OUR, [
      { kind: 'open', out: 500_000_000 }, // SOL leg deposited
      { kind: 'buy', out: 500_000_000 }, // token leg bought (attributed at open, #140)
      { kind: 'close', in: 470_000_000 }, // SOL returned at close (written by the confirm worker)
    ]);
    const { rt, setSellDelta } = await mkRuntime(U);
    setSellDelta(600_000_000); // the residual sell credits the owner +0.6 SOL
    const CMD = 'sell-cmd-worked';
    shared.pendingSellMints.set(CMD, {
      tokenMint: WSOL,
      nonSolSymbol: 'TKN',
      pool: 'POOL',
      ourPosition: OUR, // a CLOSE-path sell → attributed to this position
    });
    await rt.onSellConfirmed({ commandId: CMD, sig: 'SELLSIG', pool: 'POOL' });
    // (a) the SELL row landed: lamports_in = the owner's +0.6 delta, attributed to OUR.
    const rows = await ledgerRows(U, OUR);
    expect(rows.find((r) => r.kind === 'sell')).toMatchObject({
      lamportsIn: 600_000_000,
      lamportsOut: 0,
      sig: 'SELLSIG',
    });
    // (b) the DEFERRED fee is now assessed on the TRUE base +0.07 SOL.
    const [fee] = await feeRows(OUR);
    expect(fee).toMatchObject({
      basePnlLamports: 70_000_000,
      feeLamports: 3_500_000,
      state: 'pending',
    });
  });

  it('a WALLET-SWEEP sell (ourPosition null) writes NO ledger row and assesses NO fee (it is not a position leg)', async () => {
    // WHY (#140): only a CLOSE-path sell is attributed to a position; a wallet-residual sweep sell must never write
    // a row (it would fabricate proceeds for some position). The stash's null ourPosition is the discriminator.
    const U = 'fee140-sweepsell';
    const { rt, setSellDelta } = await mkRuntime(U);
    setSellDelta(999_000_000);
    const CMD = 'sell-cmd-sweep';
    shared.pendingSellMints.set(CMD, {
      tokenMint: WSOL,
      nonSolSymbol: null,
      pool: 'POOL',
      ourPosition: null, // wallet-sweep sell
    });
    await rt.onSellConfirmed({ commandId: CMD, sig: 'SWEEPSIG', pool: 'POOL' });
    const anyRow = await db
      .select()
      .from(schema.positionLedger)
      .where(eq(schema.positionLedger.sig, 'SWEEPSIG'));
    expect(anyRow).toHaveLength(0); // no ledger row anywhere for a sweep sell
  });

  it('SHARED-WALLET over-attribution: the first same-mint position to close is credited the JOINT proceeds; the second gets none (counted once)', async () => {
    // WHY (#140 risk): publishSell sells the WHOLE wallet balance of the mint, so with two concurrent same-mint
    // positions the FIRST close-sell's owner delta is the JOINT proceeds. Attributing it to that one position
    // over-credits it and under-credits the second — but the joint proceeds are counted EXACTLY ONCE across the pair
    // (never double). Bounded by maxConcurrentPerToken. This test documents + locks that boundedness.
    const U = 'fee140-shared';
    const POS1 = 'OUR_SHARE_1';
    const POS2 = 'OUR_SHARE_2';
    for (const p of [POS1, POS2])
      await seed(U, p, [
        { kind: 'open', out: 500_000_000 },
        { kind: 'buy', out: 500_000_000 },
        { kind: 'close', in: 400_000_000 },
      ]);
    const { rt, setSellDelta } = await mkRuntime(U);
    // POS1 closes first: its sell drains the whole mint balance (both legs) → owner delta = 1.2 SOL (JOINT).
    setSellDelta(1_200_000_000);
    shared.pendingSellMints.set('c1', {
      tokenMint: WSOL,
      nonSolSymbol: null,
      pool: 'P',
      ourPosition: POS1,
    });
    await rt.onSellConfirmed({ commandId: 'c1', sig: 'SELL1', pool: 'P' });
    // POS2 closes next: nothing left to sell → a 0-delta sell confirm.
    setSellDelta(0);
    shared.pendingSellMints.set('c2', {
      tokenMint: WSOL,
      nonSolSymbol: null,
      pool: 'P',
      ourPosition: POS2,
    });
    await rt.onSellConfirmed({ commandId: 'c2', sig: 'SELL2', pool: 'P' });
    // POS1 over-credited: base = (0.4 + 1.2) − (0.5 + 0.5) = +0.6 SOL → fee 0.03.
    const [fee1] = await feeRows(POS1);
    expect(fee1).toMatchObject({ basePnlLamports: 600_000_000, feeLamports: 30_000_000 });
    // POS2 under-credited: base = 0.4 − (0.5 + 0.5) + 0 = −0.6 SOL → a loser → NO fee row (the joint 1.2 is NOT
    // double-counted here — it was already booked to POS1).
    expect(await feeRows(POS2)).toHaveLength(0);
  });

  it('finalizeToken2022Open attributes the BUY row to the persisted position (wide/Token-2022 open path)', async () => {
    // WHY (#140): a two-sided open buys the token leg in a SEPARATE tx; that SOL spend must be attributed to the
    // opened position or the fee at close over-charges. For the Token-2022/wide-classic path the attribution lands
    // at the mirror finalize (the persist point), keyed by the buy sig threaded create → deposit → mirror.
    const U = 'fee140-t2022buy';
    const OUR = Keypair.generate().publicKey.toBase58();
    const { rt } = await mkRuntime(U);
    const CMD = 'deposit-cmd-t2022';
    const mirrors = rt.pendingOpenMapsView().token2022Mirrors as unknown as Map<string, unknown>;
    mirrors.set(CMD, {
      leaderPosition: 'LP_T2022_BUY',
      leader: LEADER,
      ourPosition: OUR,
      pool: 'POOL',
      nonSolSymbol: 'TKN',
      nonSolMint: WSOL,
      sizeSol: 1,
      recordedSizeSol: 1,
      lower: -5,
      upper: 5,
      leaderSizeSol: 1,
      buyInLamports: 500_000_000,
      buySig: 'T2022_BUYSIG',
    });
    await rt.finalizeToken2022Open(CMD);
    const rows = await ledgerRows(U, OUR);
    expect(rows.find((r) => r.kind === 'buy')).toMatchObject({
      lamportsIn: 0,
      lamportsOut: 500_000_000,
      sig: 'T2022_BUYSIG',
    });
  });

  it('finalizeToken2022Open writes NO buy row for a ONE-SIDED wide open (no buy funds it)', async () => {
    // WHY: a one-sided wide open flows through the SAME create→deposit→finalize path but funds no token buy; the
    // helper must no-op when buyInLamports/buySig are absent — never a fabricated buy cost.
    const U = 'fee140-onesided';
    const OUR = Keypair.generate().publicKey.toBase58();
    const { rt } = await mkRuntime(U);
    const CMD = 'deposit-cmd-onesided';
    const mirrors = rt.pendingOpenMapsView().token2022Mirrors as unknown as Map<string, unknown>;
    mirrors.set(CMD, {
      leaderPosition: 'LP_ONESIDED',
      leader: LEADER,
      ourPosition: OUR,
      pool: 'POOL',
      nonSolSymbol: null,
      nonSolMint: WSOL,
      sizeSol: 1,
      recordedSizeSol: 1,
      lower: -5,
      upper: 5,
      leaderSizeSol: 1,
      // no buyInLamports / buySig — a one-sided open
    });
    await rt.finalizeToken2022Open(CMD);
    expect((await ledgerRows(U, OUR)).some((r) => r.kind === 'buy')).toBe(false);
  });

  it('publishDepositAfterPositionCreated threads the buy cost + sig deposit → mirror (so the finalize can attribute the BUY row)', async () => {
    // WHY (#140): the wide/Token-2022 buy is attributed at the finalize, which reads buyInLamports/buySig off the
    // mirror stash — so the create→deposit hop MUST carry them forward. slots() (getSlot) succeeds here so the flow
    // reaches the mirror set (which precedes the publish); the publish then rejects (offline bus) and we assert the
    // mirror stash already carries the buy fields.
    const { rt } = await mkRuntime('fee140-thread'); // getSlot succeeds → reaches the mirror set; bus rejects after
    const CMD = 'create-cmd-thread';
    const deposits = rt.pendingOpenMapsView().token2022Deposits as unknown as Map<string, unknown>;
    deposits.set(CMD, {
      e: {
        signature: 'sig-thread',
        blockTime: 1,
        instruction: 'AddLiquidityByStrategy2',
        depositSol: 1,
        depositTokenRaw: 0,
        withdrawSol: 0,
        claimSol: 0,
        closed: false,
        pool: Keypair.generate().publicKey.toBase58(),
        position: 'LP_THREAD',
        nonSolMint: WSOL,
        nonSolSymbol: 'TKN',
      },
      leader: LEADER,
      lower: -5,
      upper: 5,
      sizeSol: 1,
      recordedSizeSol: 1,
      prebuiltDeposit: new Transaction(), // SPLIT path → no createDlmmPair/buildAddByWeight
      buyInLamports: 500_000_000,
      buySig: 'THREAD_BUYSIG',
    });
    await rt.publishDepositAfterPositionCreated(CMD).catch(() => {}); // reaches the mirror set, then the bus/serialize rejects
    const mirrors = rt.pendingOpenMapsView().token2022Mirrors as unknown as Map<
      string,
      { buyInLamports?: number; buySig?: string }
    >;
    const [m] = [...mirrors.values()];
    expect(m).toMatchObject({ buyInLamports: 500_000_000, buySig: 'THREAD_BUYSIG' });
  });

  it('a getTransaction failure on the sell-confirm still ASSESSES the fee (best-effort row) — never leaves it unassessed', async () => {
    // WHY (#140 robustness): the SELL row is best-effort. If the sell tx meta cannot be read, we still assess on the
    // ledger as it stands (open + close) — the SAME base the backstop would compute — rather than silently skip.
    const U = 'fee140-selltxfail';
    const OUR = 'OUR_SELLTXFAIL';
    await seed(U, OUR, [
      { kind: 'open', out: 1_000_000_000 },
      { kind: 'close', in: 1_400_000_000 }, // base +0.4 SOL without a sell row
    ]);
    const conn = {
      getSlot: async () => 0,
      getTransaction: async () => {
        throw new Error('rpc 429');
      },
    } as unknown as Connection;
    const rt = await createUserRuntime(
      { ...shared, conn, operatorFeeAddress: OPERATOR_FEE },
      U,
      opts,
    );
    shared.pendingSellMints.set('cx', {
      tokenMint: WSOL,
      nonSolSymbol: null,
      pool: 'P',
      ourPosition: OUR,
    });
    await rt.onSellConfirmed({ commandId: 'cx', sig: 'SIGX', pool: 'P' });
    expect(
      await db.select().from(schema.positionLedger).where(eq(schema.positionLedger.sig, 'SIGX')),
    ).toHaveLength(0); // no sell row (getTransaction threw)…
    const [fee] = await feeRows(OUR);
    expect(fee).toMatchObject({ basePnlLamports: 400_000_000, feeLamports: 20_000_000 }); // …but the fee IS assessed
  });

  it('DEFERRED-then-FAILED sell → the periodic backstop still assesses (no permanently-unassessed tail), idempotently', async () => {
    // WHY (#140 no-miss): moving the trigger to the sell-confirm created a "never assessed" path — a close-sell that
    // FAILS to land means onSellConfirmed never runs. FAILURE INJECTED: we drive markClosed + a WINNING ledger but
    // NEVER call onSellConfirmed (the sell failed) → the ONLY thing that can assess this position is the backstop.
    // And a second backstop pass must not double-charge (idempotent via the anti-join + feeLedger.assess).
    const U = 'fee140-backstop';
    const LP = 'LP_BACKSTOP';
    const OUR = 'OUR_BACKSTOP';
    const { rt } = await mkRuntime(U);
    await seed(U, OUR, [
      { kind: 'open', out: 1_000_000_000 },
      { kind: 'buy', out: 500_000_000 },
      { kind: 'close', in: 2_000_000_000 }, // base = 2.0 − (1.0 + 0.5) = +0.5 SOL → fee 0.025
    ]);
    await rt.store.saveOpen({
      leaderPosition: LP,
      leaderAddress: LEADER,
      ourPosition: OUR,
      pool: 'POOL',
      nonSolSymbol: 'TKN',
      nonSolMint: WSOL,
      sizeSol: 1,
      lowerBin: -1,
      upperBin: 1,
      openedAt: Date.now(),
      status: 'open' as const,
    });
    await rt.store.markClosed(LP); // CLOSED on-chain, but the sell failed → NEVER assessed
    expect(await feeRows(OUR)).toHaveLength(0); // precondition: unassessed
    const backstop = () =>
      runClosedFeeBackstop({
        log,
        listClosedWithoutFee: (b, l, c) => positionsRepo.listClosedWithoutFee(b, l, c),
        batchLimit: 25,
        graceMs: 0,
        nowMs: () => Date.now() + 3_600_000, // clock past the grace so this just-closed position is actionable
        bootedUserIds: () => [U],
        runtimeFor: (uid) => (uid === U ? rt : undefined),
      });
    await backstop();
    const [fee] = await feeRows(OUR);
    expect(fee).toMatchObject({
      basePnlLamports: 500_000_000,
      feeLamports: 25_000_000,
      state: 'pending',
    });
    await backstop(); // second pass → the anti-join now excludes OUR (it has a fee row) → no double-charge
    expect(await feeRows(OUR)).toHaveLength(1);
  });
});

describe('UserRuntime — stop-close arms the durable re-close row BEFORE publishing (#153)', () => {
  // WHY: a STOP leaves the LEADER position OPEN, so the `leaderClosed` failsafe retry never fires for a stop close —
  // the persisted rugExitPending row is the ONLY channel that re-closes it after a restart. If that INSERT runs
  // AFTER the publish (the pre-fix fire-and-forget shape), a SIGKILL in the window between publish and INSERT loses
  // the row → a stop close that failed to land is NEVER re-closed once the brain restarts (a silent dormant
  // position — the #1 forbidden failure). The fix arms + AWAITS the durable persist BEFORE the publish; this test
  // pins that call order so any regression back to persist-after-publish fails.
  it('commits the durable addPending BEFORE publishSafetyClose is entered (a crash mid-publish still re-closes)', async () => {
    const USER = 'stop-close-153-user';
    const order: string[] = [];
    const rt = await createUserRuntime(shared, USER, opts);

    // publishSafetyClose evaluates `new PublicKey(m.pool | m.ourPosition)` as buildCloseTx arguments BEFORE the seam
    // runs — real base58 keys are required or that constructor throws first and the publish marker never fires.
    const pool = Keypair.generate().publicKey.toBase58();
    const ourPosition = Keypair.generate().publicKey.toBase58();
    rt.registry.open({
      leaderPosition: '__stop_close_153_leader_pos__',
      leaderAddress: LEADER,
      ourPosition,
      pool,
      nonSolSymbol: 'TOK',
      nonSolMint: 'MINT',
      sizeSol: 0.2,
      lowerBin: -5,
      upperBin: 5,
      openedAt: Date.now(),
    });

    // Marker A — the durable persist COMMITS: delegate to the REAL store, THEN record. A pre-fix fire-and-forget
    // (void) write would resolve its record AFTER the publish marker — or not before applyStopCloses returns at all.
    const realAddPending = rt.rugExitStore.addPending.bind(rt.rugExitStore);
    vi.spyOn(rt.rugExitStore, 'addPending').mockImplementation(async (our: string) => {
      await realAddPending(our);
      order.push('addPending');
    });

    // Marker B — publishSafetyClose ENTERED: buildCloseTx is its first external step (before slots()/bus.publish).
    // Throwing here embodies the "close publish fails" branch #153 guards; executeStopClosePlan's .catch swallows it.
    vi.mocked(buildCloseTx).mockImplementationOnce(async () => {
      order.push('publish');
      throw new Error('stub: halt publishSafetyClose at the tx-build seam');
    });

    // A GLOBAL stop (user.enabled true→false) force-closes every open mirror (SPEC §4.3).
    const startedCfg = { ...CONFIG_DEFAULTS, user: { ...CONFIG_DEFAULTS.user, enabled: true } };
    const stoppedCfg = { ...CONFIG_DEFAULTS, user: { ...CONFIG_DEFAULTS.user, enabled: false } };
    await rt.applyStopCloses(startedCfg, stoppedCfg);

    // The re-close row is committed STRICTLY BEFORE the publish path is entered — pre-fix (void addPending AFTER
    // publish) yields ['publish'] / ['publish', 'addPending'] and fails this exact-order assertion.
    expect(order).toEqual(['addPending', 'publish']);

    // And the persisted row is really there → the reconcile can re-close this stop even after a restart.
    const rows = await db
      .select({ ourPosition: schema.rugExitPendings.ourPosition })
      .from(schema.rugExitPendings)
      .where(
        and(
          eq(schema.rugExitPendings.userId, USER),
          eq(schema.rugExitPendings.ourPosition, ourPosition),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

describe('UserRuntime — fixed-size RESYNC mirrors a leader de-risk (finding #143)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const DERISK_LEADER = Keypair.generate().publicKey.toBase58();
  const LEADER_POS = Keypair.generate().publicKey.toBase58();
  const OUR_POS = Keypair.generate().publicKey.toBase58();
  const POOL = Keypair.generate().publicKey.toBase58();
  const NONSOL_MINT = Keypair.generate().publicKey.toBase58();
  const HALF_SOL = 500_000_000n; // leader SOL/Y leg per bin AFTER a de-risk: 0.5 SOL (leader total 1.0 over 2 bins)
  const FULL_SOL = 2_500_000_000n; // our SOL/Y leg per bin, STILL full: 2.5 SOL (our total 5.0 = the fixed size)
  const TOK = 1_000n; // a token/X leg on every bin so readStableShape accepts the leader shape on the first poll

  // A DLMM position shape with BOTH legs on each bin over [0, 1] (both-legs ⇒ readStableShape returns immediately).
  const shape = (ySol: bigint) => ({
    positionPubkey: '__resync_143__',
    activeBinId: 0,
    lowerBinId: 0,
    upperBinId: 1,
    perBin: [
      { binId: 0, x: TOK, y: ySol },
      { binId: 1, x: TOK, y: ySol },
    ],
  });

  const sharedResync: SharedBrainDeps = {
    ...shared,
    poolReader: {
      loadPoolMeta: async (pool: string) =>
        pool === POOL
          ? ({ solSide: 'Y', binStep: 20, mintX: NONSOL_MINT, mintY: WSOL } as LoadedPoolMeta)
          : null,
    } as unknown as OnchainPoolMetaReader,
  };

  // twoSidedMode stays 'off' (from the defaults) ⇒ a pure SOL-leg reshape (no Jupiter). Only the sizing ratio varies.
  const cfgFor = (tradeRatioPct: number | null) => ({
    ...CONFIG_DEFAULTS,
    user: {
      ...CONFIG_DEFAULTS.user,
      sizing: { ...CONFIG_DEFAULTS.user.sizing, tradeRatioPct, maxTradeSizeSol: 5 },
    },
    leaders: [{ address: DERISK_LEADER, enabled: true, maxTotalExposureSol: null, overrides: {} }],
  });

  /** Track a full-size mirror, feed a leader de-risk (withdraw) and let handleResync run to the remove-build tail. */
  async function drive(userId: string, tradeRatioPct: number | null): Promise<void> {
    const conn = new Connection('http://127.0.0.1:1');
    vi.spyOn(conn, 'getSlot').mockResolvedValue(1_000); // slots() resolves so handleResync reaches buildRemovePartial
    const rt = await createUserRuntime(
      { ...sharedResync, conn, bus: { publish: async () => undefined } as unknown as RedisBus },
      userId,
      { ...opts, leader: DERISK_LEADER, initialConfig: cfgFor(tradeRatioPct) },
    );
    rt.registry.open({
      leaderPosition: LEADER_POS,
      leaderAddress: DERISK_LEADER,
      ourPosition: OUR_POS,
      pool: POOL,
      nonSolSymbol: 'TKN',
      nonSolMint: NONSOL_MINT,
      sizeSol: 5, // we currently hold the full fixed size
      lowerBin: 0,
      upperBin: 1,
      openedAt: Date.now(),
    });
    // readStableShape(leader) and readLeaderPositionShape(our) both hit this mock — split by the position pubkey.
    vi.mocked(readLeaderPositionShape).mockImplementation(async (_c, _p, _o, position) =>
      position === LEADER_POS ? shape(HALF_SOL) : shape(FULL_SOL),
    );
    // Reaching the remove build proves a shrink was planned; reject so the test never touches real RPC past this hop.
    vi.mocked(buildRemovePartial).mockClear();
    vi.mocked(buildRemovePartial).mockRejectedValue(new Error('resync-remove-stub'));

    rt.onEvent(
      {
        signature: `sig-143-${userId}`,
        blockTime: 1,
        instruction: 'RemoveLiquidityByRange2',
        depositSol: 0,
        depositTokenRaw: 0,
        withdrawSol: 2, // > RESYNC_MIN_CHANGE_SOL → a real shrink, routes a tracked position to resync
        claimSol: 0,
        closed: false,
        pool: POOL,
        position: LEADER_POS,
        nonSolMint: NONSOL_MINT,
        nonSolSymbol: 'TKN',
      },
      'ws',
      DERISK_LEADER,
      1,
    );
    await waitFor(
      () => Promise.resolve(vi.mocked(buildRemovePartial).mock.calls.length),
      (n) => n > 0,
    );
  }

  it('fixed-size mode: a leader de-risk PLANS a shrink (reaches the remove build) — not the old `?? 0` no-op', async () => {
    // WHY (#143, robustness): fixed-size mode must still follow a leader de-risk. Pre-fix the resync ratio was `?? 0`,
    // which zeroed planReshape's factor → EMPTY plan → reshape.noop → the copy rode the whole drawdown FULLY deployed
    // until the final close. This FAILS if the fixed-size resync ratio regresses to 0: buildRemovePartial is then
    // never reached (the reshape is a silent no-op).
    await drive('resync-fixed-143', null);
    expect(buildRemovePartial).toHaveBeenCalled(); // the de-risk IS mirrored — a shrink (remove) was planned
  });

  it('ratio mode (pct set) is unchanged — the same de-risk still plans a shrink', async () => {
    // Guard: the fix must not alter ratio mode (never broken). 50% × the de-risked leader still shrinks the copy.
    await drive('resync-ratio-143', 50);
    expect(buildRemovePartial).toHaveBeenCalled();
  });
});

describe('UserRuntime — a RESYNC records the tracked size from PUBLISHED ops only (finding #145)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const R_LEADER = Keypair.generate().publicKey.toBase58();
  const R_LEADER_POS = Keypair.generate().publicKey.toBase58();
  const R_OUR_POS = Keypair.generate().publicKey.toBase58();
  const R_POOL = Keypair.generate().publicKey.toBase58();
  const R_MINT = Keypair.generate().publicKey.toBase58();
  // A valid 32-byte base58 blockhash so a published remove/add tx serializes (the coffre re-sets a fresh one).
  const R_BLOCKHASH = Keypair.generate().publicKey.toBase58();

  // A 2-bin DLMM shape with BOTH legs on each bin over [0,1] (both-legs ⇒ readStableShape settles on the first poll).
  // `xRaw` = the non-SOL/X (token) leg per bin (raw units); `ySol` = the SOL/Y leg per bin (lamports).
  const shape = (xRaw: bigint, ySol: bigint) => ({
    positionPubkey: '__resync_145__',
    activeBinId: 0,
    lowerBinId: 0,
    upperBinId: 1,
    perBin: [
      { binId: 0, x: xRaw, y: ySol },
      { binId: 1, x: xRaw, y: ySol },
    ],
  });

  const sharedR: SharedBrainDeps = {
    ...shared,
    poolReader: {
      loadPoolMeta: async (pool: string) =>
        pool === R_POOL
          ? ({ solSide: 'Y', binStep: 20, mintX: R_MINT, mintY: WSOL } as LoadedPoolMeta)
          : null,
    } as unknown as OnchainPoolMetaReader,
  };

  // ratio 100% ⇒ copyRatio 1.0 (deterministic newSize = leader SOL total, capped at maxTradeSizeSol = 5). infiniteAdd
  // ON so a leader ADD (deposit) routes to resync (a GROW) — a withdrawal always resyncs regardless (spec §8).
  const cfg = (twoSidedMode: 'on' | 'off', capTotalSol: number | null = null) => ({
    ...CONFIG_DEFAULTS,
    user: {
      ...CONFIG_DEFAULTS.user,
      twoSidedMode,
      infiniteAdd: true,
      sizing: { ...CONFIG_DEFAULTS.user.sizing, tradeRatioPct: 100, maxTradeSizeSol: 5 },
      caps: { ...CONFIG_DEFAULTS.user.caps, maxTotalExposureSol: capTotalSol },
    },
    leaders: [{ address: R_LEADER, enabled: true, maxTotalExposureSol: null, overrides: {} }],
  });

  /** Boot a runtime whose bus CAPTURES published commands, open a mirror at `startSizeSol`, drive ONE resync event,
   *  and wait until handleResync's terminal `store.updateSize` fires (a precise, race-free completion signal). */
  async function driveResync(p: {
    userId: string;
    twoSidedMode: 'on' | 'off';
    startSizeSol: number;
    leader: { x: bigint; y: bigint };
    ours: { x: bigint; y: bigint };
    depositSol: number;
    withdrawSol: number;
    instruction: string;
    capTotalSol?: number | null;
  }) {
    const published: Array<Record<string, unknown>> = [];
    const conn = new Connection('http://127.0.0.1:1');
    vi.spyOn(conn, 'getSlot').mockResolvedValue(1_000); // slots() resolves so handleResync reaches the build/publish tail
    const blockhashCache = new BlockhashCache(async () => ({
      blockhash: R_BLOCKHASH,
      lastValidBlockHeight: 0,
    }));
    await blockhashCache.start();
    const bus = {
      publish: async (_s: string, _h: string, _k: string, payload: Record<string, unknown>) => {
        published.push(payload);
        return 'sid';
      },
    } as unknown as RedisBus;
    const rt = await createUserRuntime({ ...sharedR, conn, bus, blockhashCache }, p.userId, {
      ...opts,
      leader: R_LEADER,
      initialConfig: cfg(p.twoSidedMode, p.capTotalSol ?? null),
    });
    rt.registry.open({
      leaderPosition: R_LEADER_POS,
      leaderAddress: R_LEADER,
      ourPosition: R_OUR_POS,
      pool: R_POOL,
      nonSolSymbol: 'TKN',
      nonSolMint: R_MINT,
      sizeSol: p.startSizeSol,
      lowerBin: 0,
      upperBin: 1,
      openedAt: Date.now(),
    });
    await rt.store.saveOpen(rt.registry.get(R_LEADER_POS)!);
    const updateSize = vi.spyOn(rt.store, 'updateSize');
    // readStableShape(leader) and readLeaderPositionShape(our) both hit this mock — split by the position pubkey.
    vi.mocked(readLeaderPositionShape).mockImplementation(async (_c, _pool, _o, position) =>
      position === R_LEADER_POS ? shape(p.leader.x, p.leader.y) : shape(p.ours.x, p.ours.y),
    );
    rt.onEvent(
      {
        signature: `sig-145-${p.userId}`,
        blockTime: 1,
        instruction: p.instruction,
        depositSol: p.depositSol,
        depositTokenRaw: 0,
        withdrawSol: p.withdrawSol,
        claimSol: 0,
        closed: false,
        pool: R_POOL,
        position: R_LEADER_POS,
        nonSolMint: R_MINT,
        nonSolSymbol: 'TKN',
      },
      'ws',
      R_LEADER,
      1,
    );
    await waitFor(
      () => Promise.resolve(updateSize.mock.calls.length),
      (n) => n > 0,
    );
    const recorded = updateSize.mock.calls.find((c) => c[0] === R_LEADER_POS)?.[1];
    return { rt, published, recorded };
  }

  it('a two-sided GROW whose token deficit is UNQUOTABLE does NOT bump the recorded size (caps stay accurate)', async () => {
    // WHY (#145, money): a leader doubles the position but the token leg can't be quoted (Jupiter blip) → NO add is
    // published, so the copy did NOT grow. Pre-fix handleResync wrote the computed TARGET unconditionally → sizeSol
    // doubled in the registry + DB with no matching on-chain liquidity: the exposure caps then block legitimate opens
    // and the feed reports capital the copy never deployed. The size MUST stay at the current exposure until an add
    // actually publishes. A wide-open Jupiter rejection here reproduces the blip deterministically.
    vi.mocked(getJupiterQuote).mockRejectedValue(new Error('jupiter blip — token unquotable'));
    const { rt, published, recorded } = await driveResync({
      userId: 'resync-145-grow-skip',
      twoSidedMode: 'on',
      startSizeSol: 2.5, // we currently hold half the (about-to-double) leader
      leader: { x: 2_000n, y: 2_500_000_000n }, // leader SOL leg 2.5/bin × 2 = 5.0 (a 2× grow) + a real token deficit
      ours: { x: 1_000n, y: 1_250_000_000n }, // our SOL leg 1.25/bin × 2 = 2.5
      depositSol: 2, // a leader ADD → routes the tracked position to resync
      withdrawSol: 0,
      instruction: 'AddLiquidityByStrategy2',
    });
    // The grow was skipped (buy unquotable) → NOTHING published, and the size is CLAMPED to the current 2.5 (not 5.0).
    expect(published.some((c) => c.kind === 'buy' || c.kind === 'add')).toBe(false);
    expect(recorded).toBeCloseTo(2.5);
    expect(rt.registry.get(R_LEADER_POS)?.sizeSol).toBeCloseTo(2.5);
    // Caps read the same tracked size → they never over-count exposure for an add that never landed.
    expect(rt.capsState(R_LEADER, R_MINT).totalExposureSol).toBeCloseTo(2.5);
    expect(rt.capsState(R_LEADER, R_MINT).leaderExposureSol).toBeCloseTo(2.5);
    vi.mocked(getJupiterQuote).mockReset();
  });

  it('a SHRINK whose removes DO publish records the shrunk size (removes land synchronously)', async () => {
    // WHY: the mirror side of #145 — a published op MUST update the tracked size. A leader de-risk publishes removes
    // (which land synchronously), so the recorded size drops to the shrunk target; this pins that the shrink path
    // still records (the same recording path that must NOT fire for a skipped grow, above).
    vi.mocked(buildRemovePartial).mockImplementation(async () => [new Transaction()]);
    const { rt, published, recorded } = await driveResync({
      userId: 'resync-145-shrink',
      twoSidedMode: 'off',
      startSizeSol: 5, // full size before the de-risk
      leader: { x: 1_000n, y: 500_000_000n }, // leader SOL leg 0.5/bin × 2 = 1.0 (a de-risk)
      ours: { x: 1_000n, y: 2_500_000_000n }, // our SOL leg 2.5/bin × 2 = 5.0
      depositSol: 0,
      withdrawSol: 2, // a leader REMOVE → resync
      instruction: 'RemoveLiquidityByRange2',
    });
    expect(published.some((c) => c.kind === 'remove')).toBe(true);
    expect(recorded).toBeCloseTo(1); // copyRatio 1.0 × leader 1.0 SOL, capped at 5
    expect(rt.registry.get(R_LEADER_POS)?.sizeSol).toBeCloseTo(1);
    expect(
      (await rt.store.loadOpen()).find((m) => m.leaderPosition === R_LEADER_POS)?.sizeSol,
    ).toBe(1);
  });

  it('a one-sided GROW whose add DOES publish records the grown size (the published add is real)', async () => {
    // WHY: the fix must still RECORD a grow that actually publishes — otherwise the clamp would silently UNDER-count
    // every legitimate grow (the dangerous inverse: caps over-admit). A one-sided add publishes synchronously here,
    // so the tracked size rises to the full target; this pins the `growPublished` recording path.
    vi.mocked(buildAddByWeight).mockImplementation(async () => new Transaction());
    const { rt, published, recorded } = await driveResync({
      userId: 'resync-145-grow',
      twoSidedMode: 'off',
      startSizeSol: 1, // undersized before the leader adds
      leader: { x: 1_000n, y: 2_500_000_000n }, // leader SOL leg 2.5/bin × 2 = 5.0 (a grow)
      ours: { x: 1_000n, y: 500_000_000n }, // our SOL leg 0.5/bin × 2 = 1.0
      depositSol: 2, // a leader ADD → resync
      withdrawSol: 0,
      instruction: 'AddLiquidityByStrategy2',
    });
    expect(published.some((c) => c.kind === 'add')).toBe(true);
    expect(recorded).toBeCloseTo(5); // copyRatio 1.0 × leader 5.0 SOL, capped at 5
    expect(rt.registry.get(R_LEADER_POS)?.sizeSol).toBeCloseTo(5);
    expect(
      (await rt.store.loadOpen()).find((m) => m.leaderPosition === R_LEADER_POS)?.sizeSol,
    ).toBe(5);
    vi.mocked(buildAddByWeight).mockReset();
  });

  it('a two-sided GROW defers the size to the buy CONFIRM: clamped on resync, recorded when the add publishes', async () => {
    // WHY (#145, the deferred half): when the token leg IS quotable, handleResync publishes the BUY and DEFERS the
    // add to the buy's ev:executed. The size must NOT jump on resync (the add has not landed) — it stays at the
    // current exposure — and must rise to the target ONLY once publishReshapeAddAfterBuy actually publishes the add.
    // This drives the REAL two-sided path end to end, so a regression at EITHER site (defer or record) fails here.
    vi.mocked(getJupiterQuote).mockResolvedValue({
      inputMint: R_MINT,
      outputMint: WSOL,
      inAmount: '0',
      outAmount: '500000000', // token leg valued at 0.5 SOL (both the price quote and the size-basis value quote)
      raw: {},
    });
    vi.mocked(getJupiterBuyQuoteExactIn).mockResolvedValue({
      inputMint: WSOL,
      outputMint: R_MINT,
      inAmount: '500000000', // 0.5 SOL spent buying the token deficit
      outAmount: '1000', // expected token out (raw)
      raw: {},
    });
    vi.mocked(buildJupiterSwapTx).mockResolvedValue('buytx-b64');
    // pre-buy snapshot 0 → post-buy the wallet holds the full expected 1000 (settles on the first settle read).
    vi.mocked(readOwnerTokenBalance).mockReset();
    vi.mocked(readOwnerTokenBalance).mockResolvedValueOnce(0n).mockResolvedValue(1_000n);
    vi.mocked(buildAddByWeight).mockImplementation(async () => new Transaction());

    const { rt, published, recorded } = await driveResync({
      userId: 'resync-145-2s-defer',
      twoSidedMode: 'on',
      startSizeSol: 2, // current exposure before the leader grows
      leader: { x: 2_000n, y: 2_000_000_000n }, // leader SOL leg 2.0/bin × 2 = 4.0 + a real token deficit
      ours: { x: 1_000n, y: 1_000_000_000n }, // our SOL leg 1.0/bin × 2 = 2.0
      depositSol: 2,
      withdrawSol: 0,
      instruction: 'AddLiquidityByStrategy2',
    });
    // DEFER: the buy is published, the add is NOT, and the size stays clamped at the current 2.0 (target would be 4.5).
    const buy = published.find((c) => c.kind === 'buy');
    expect(buy).toBeDefined();
    expect(published.some((c) => c.kind === 'add')).toBe(false);
    expect(recorded).toBeCloseTo(2);
    expect(rt.registry.get(R_LEADER_POS)?.sizeSol).toBeCloseTo(2);

    // RECORD: simulate the buy's ev:executed → the deferred add publishes → the size rises to the target 4.5.
    await rt.publishReshapeAddAfterBuy(buy?.commandId as string, 'buysig');
    expect(published.some((c) => c.kind === 'add')).toBe(true);
    expect(rt.registry.get(R_LEADER_POS)?.sizeSol).toBeCloseTo(4.5); // 1.0 × (4.0 SOL + 0.5 token)
    expect(
      (await rt.store.loadOpen()).find((m) => m.leaderPosition === R_LEADER_POS)?.sizeSol,
    ).toBeCloseTo(4.5);
    vi.mocked(getJupiterQuote).mockReset();
    vi.mocked(getJupiterBuyQuoteExactIn).mockReset();
    vi.mocked(buildJupiterSwapTx).mockReset();
    vi.mocked(readOwnerTokenBalance).mockReset();
    vi.mocked(buildAddByWeight).mockReset();
  });

  it('a one-sided GROW that would breach maxTotalExposureSol is BLOCKED — the add never publishes and the size clamps (idx15)', async () => {
    // WHY (idx15, exposure safety): checkCaps ran ONLY at open, so a reshape ADD grew the position past the wallet
    // maxTotalExposureSol UNCHECKED. With a 3 SOL cap and the copy already at 2.5, a leader 2× grow to 5.0 would
    // breach it → the add MUST be skipped (no on-chain deploy) and the tracked size CLAMPED to the current 2.5,
    // exactly like the OPEN-path cap block. This FAILS if the grow re-check regresses (the add would publish and the
    // exposure would exceed the cap the operator set). Shrinks are unaffected — they never breach an exposure cap.
    vi.mocked(buildAddByWeight).mockImplementation(async () => new Transaction());
    const U = 'resync-idx15-capblock';
    const { rt, published, recorded } = await driveResync({
      userId: U,
      twoSidedMode: 'off',
      startSizeSol: 2.5, // current exposure
      leader: { x: 1_000n, y: 2_500_000_000n }, // leader SOL leg 2.5/bin × 2 = 5.0 → a grow to 5.0
      ours: { x: 1_000n, y: 1_250_000_000n }, // our SOL leg 1.25/bin × 2 = 2.5
      depositSol: 2, // a leader ADD → resync (a GROW)
      withdrawSol: 0,
      instruction: 'AddLiquidityByStrategy2',
      capTotalSol: 3, // wallet total-exposure cap BELOW the 5.0 grow target
    });
    expect(published.some((c) => c.kind === 'add')).toBe(false); // the grow add was blocked
    expect(recorded).toBeCloseTo(2.5); // clamped to the current size — no exposure inflation
    expect(rt.registry.get(R_LEADER_POS)?.sizeSol).toBeCloseTo(2.5);
    expect(rt.capsState(R_LEADER, R_MINT).totalExposureSol).toBeCloseTo(2.5);
    // the block is journaled with the SAME code the open path emits (feed-visible).
    const codes = await waitFor(
      () =>
        db
          .select({ code: schema.copyJournal.code })
          .from(schema.copyJournal)
          .where(eq(schema.copyJournal.userId, U)),
      (rows) => rows.some((r) => r.code === 'cap.max_total_exposure'),
    );
    expect(codes.some((r) => r.code === 'cap.max_total_exposure')).toBe(true);
    vi.mocked(buildAddByWeight).mockReset();
  });

  it('a two-sided GROW whose COMBINED value exceeds the cap deploys ≤ the cap and records the true combined (finding #158)', async () => {
    // WHY (#158, money — incomplete #94): the resync factor capped only the SOL leg (min(ratio, maxSol/leaderSol))
    // while #94 caps the COMBINED at OPEN. Leader worth 4 SOL leg + token worth 6 SOL (combined 10), cap 5, ratio
    // 100% → the buggy resync deployed factor 1.0 on BOTH legs = a 4 SOL leg add + a ~6 SOL token BUY = ~10 SOL (2×
    // the per-trade cap), while the mirror size clamped to 5 → the per-trade AND aggregate exposure caps were breached
    // with the recorded size UNDER-counting the deploy 2×. The fix folds the token leg's SOL value into the factor
    // (min(1, 5/(4+6)) = 0.5): the SOL add + the token buy == EXACTLY the 5 SOL cap, and the recorded size == that
    // true combined deployment (SOL leg + buy spend), consistent with the OPEN path. Drives the REAL two-sided path.
    const PRICE_LAMPORTS_PER_RAW = 1_500_000n; // full leg 4000 raw → 6 SOL; the deficit is priced at the SAME rate
    vi.mocked(getJupiterQuote).mockImplementation(async (_url, _mint, amountRaw) => ({
      inputMint: R_MINT,
      outputMint: WSOL,
      inAmount: String(amountRaw),
      outAmount: String(BigInt(amountRaw) * PRICE_LAMPORTS_PER_RAW), // value quote (full leg) AND buy-price quote (deficit)
      raw: {},
    }));
    vi.mocked(getJupiterBuyQuoteExactIn).mockImplementation(async (_url, _mint, solToSpend) => ({
      inputMint: WSOL,
      outputMint: R_MINT,
      inAmount: String(solToSpend), // the SOL the buy spends == the priced deficit (echoed)
      outAmount: '1000', // expected token out (raw) — the wallet settles to this
      raw: {},
    }));
    vi.mocked(buildJupiterSwapTx).mockResolvedValue('buytx-b64');
    vi.mocked(readOwnerTokenBalance).mockReset();
    vi.mocked(readOwnerTokenBalance).mockResolvedValueOnce(0n).mockResolvedValue(1_000n);
    vi.mocked(buildAddByWeight).mockImplementation(async () => new Transaction());

    const { rt, published, recorded } = await driveResync({
      userId: 'resync-158-combined-cap',
      twoSidedMode: 'on',
      startSizeSol: 2, // prior recorded exposure (undersized → the resync grows)
      leader: { x: 2_000n, y: 2_000_000_000n }, // SOL leg 2.0/bin × 2 = 4.0; token 2000/bin × 2 = 4000 raw (worth 6 SOL)
      ours: { x: 0n, y: 0n }, // empty → the resync builds BOTH legs from scratch (deploy == SOL add + token buy)
      depositSol: 2,
      withdrawSol: 0,
      instruction: 'AddLiquidityByStrategy2',
    });

    const buy = published.find((c) => c.kind === 'buy');
    const buySpendSol = buy?.sizeSol as number;
    // CORE #158 assertion: the token buy is priced off the CAPPED factor (0.5 × 6 SOL = 3), NOT the uncapped full leg
    // (6 SOL). Pre-fix the SOL-only factor 1.0 made this buy spend ~6 SOL and the SOL add ~4 SOL → ~10 SOL deployed.
    expect(buySpendSol).toBeCloseTo(3);
    expect(recorded).toBeCloseTo(2); // DEFER: clamped to the current size until the add lands (no inflation)

    await rt.publishReshapeAddAfterBuy(buy?.commandId as string, 'buysig');
    const add = published.find((c) => c.kind === 'add');
    const addSol = add?.sizeSol as number;
    const finalSize = rt.registry.get(R_LEADER_POS)?.sizeSol as number;
    // The COMBINED deployment (SOL leg add + the token buy) is bounded by the per-trade cap — NOT ~2× it.
    expect(addSol + buySpendSol).toBeLessThanOrEqual(5);
    expect(addSol + buySpendSol).toBeCloseTo(5); // factor 0.5 × combined 10 == exactly the 5 SOL cap
    // The recorded size == the TRUE combined deployment (SOL leg + buy spend), like the OPEN path — no 2× under-count.
    expect(finalSize).toBeCloseTo(addSol + buySpendSol);
    expect(finalSize).toBeCloseTo(5);

    vi.mocked(getJupiterQuote).mockReset();
    vi.mocked(getJupiterBuyQuoteExactIn).mockReset();
    vi.mocked(buildJupiterSwapTx).mockReset();
    vi.mocked(readOwnerTokenBalance).mockReset();
    vi.mocked(buildAddByWeight).mockReset();
  });
});

describe('UserRuntime — a RESYNC is PREEMPTED by a pending leader CLOSE (finding #146)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const P_LEADER = Keypair.generate().publicKey.toBase58();
  const P_LEADER_POS = Keypair.generate().publicKey.toBase58();
  const P_OUR_POS = Keypair.generate().publicKey.toBase58();
  const P_POOL = Keypair.generate().publicKey.toBase58();
  const P_MINT = Keypair.generate().publicKey.toBase58();
  const P_BLOCKHASH = Keypair.generate().publicKey.toBase58(); // a valid 32-byte base58 blockhash so a tx serializes

  // Both legs on each bin ⇒ readStableShape settles on the FIRST inner read (no inner retry): exactly one leader read
  // per outer iteration, so the read counter cleanly measures how far the retry loop got before it was preempted.
  const shape = (xRaw: bigint, ySol: bigint) => ({
    positionPubkey: '__resync_146__',
    activeBinId: 0,
    lowerBinId: 0,
    upperBinId: 1,
    perBin: [
      { binId: 0, x: xRaw, y: ySol },
      { binId: 1, x: xRaw, y: ySol },
    ],
  });

  const sharedP: SharedBrainDeps = {
    ...shared,
    poolReader: {
      loadPoolMeta: async (pool: string) =>
        pool === P_POOL
          ? ({ solSide: 'Y', binStep: 20, mintX: P_MINT, mintY: WSOL } as LoadedPoolMeta)
          : null,
    } as unknown as OnchainPoolMetaReader,
  };

  // ratio 100%, twoSidedMode off (pure SOL-leg reshape, no Jupiter), infiniteAdd on so a leader ADD would resync too.
  const cfg = () => ({
    ...CONFIG_DEFAULTS,
    user: {
      ...CONFIG_DEFAULTS.user,
      twoSidedMode: 'off' as const,
      infiniteAdd: true,
      sizing: { ...CONFIG_DEFAULTS.user.sizing, tradeRatioPct: 100, maxTradeSizeSol: 5 },
    },
    leaders: [{ address: P_LEADER, enabled: true, maxTotalExposureSol: null, overrides: {} }],
  });

  /** Boot a runtime whose bus CAPTURES published commands, with a valid blockhash cache, and open a full-size mirror. */
  async function boot(userId: string) {
    const published: Array<Record<string, unknown>> = [];
    const conn = new Connection('http://127.0.0.1:1');
    vi.spyOn(conn, 'getSlot').mockResolvedValue(1_000); // slots() resolves so handleClose reaches the publish
    const blockhashCache = new BlockhashCache(async () => ({
      blockhash: P_BLOCKHASH,
      lastValidBlockHeight: 0,
    }));
    await blockhashCache.start();
    const bus = {
      publish: async (_s: string, _h: string, _k: string, payload: Record<string, unknown>) => {
        published.push(payload);
        return 'sid';
      },
    } as unknown as RedisBus;
    const rt = await createUserRuntime({ ...sharedP, conn, bus, blockhashCache }, userId, {
      ...opts,
      leader: P_LEADER,
      initialConfig: cfg(),
    });
    rt.registry.open({
      leaderPosition: P_LEADER_POS,
      leaderAddress: P_LEADER,
      ourPosition: P_OUR_POS,
      pool: P_POOL,
      nonSolSymbol: 'TKN',
      nonSolMint: P_MINT,
      sizeSol: 5, // we currently hold the full fixed size
      lowerBin: 0,
      upperBin: 1,
      openedAt: Date.now(),
    });
    await rt.store.saveOpen(rt.registry.get(P_LEADER_POS)!);
    return { rt, published };
  }

  const resyncEvent = (userId: string) => ({
    signature: `sig-146-resync-${userId}`,
    blockTime: 1,
    instruction: 'RemoveLiquidityByRange2',
    depositSol: 0,
    depositTokenRaw: 0,
    withdrawSol: 2, // > RESYNC_MIN_CHANGE_SOL → changeExpected → the retry loop runs
    claimSol: 0,
    closed: false,
    pool: P_POOL,
    position: P_LEADER_POS,
    nonSolMint: P_MINT,
    nonSolSymbol: 'TKN',
  });

  const closeEvent = (userId: string) => ({
    signature: `sig-146-close-${userId}`,
    blockTime: 1,
    instruction: 'ClosePosition',
    depositSol: 0,
    depositTokenRaw: 0,
    withdrawSol: 0,
    claimSol: 0,
    closed: true, // decoded PositionClose leg — the robust close signal the router (and the preempt) key off
    pool: P_POOL,
    position: P_LEADER_POS,
    nonSolMint: P_MINT,
    nonSolSymbol: 'TKN',
  });

  it('a resync STUCK in its retry loop ABORTS the moment a close for the same position is queued — the close is handled without waiting the retry budget, and no size is written', async () => {
    // WHY (#146, close-latency, the #1 pillar): the resync retry loop holds the per-position serial queue while it
    // re-reads the leader shape (RESYNC_READ_RETRIES × readStableShape ≈ tens of seconds). A leader CLOSE queued
    // behind it MUST NOT wait out that budget — every extra second on a rugging pool is real loss. The loop is now
    // preempted: it bails (no publish, no size write) the instant a close for the same position is observed, so the
    // close runs next. This FAILS if the preempt regresses — the close would publish only after the full retry
    // budget (leaderReads would reach the budget) and a stale resync size would be written.
    const { rt, published } = await boot('resync-146-preempt');
    const updateSize = vi.spyOn(rt.store, 'updateSize');
    // A gate that pauses the resync INSIDE its first leader read, so the close is injected while it is provably
    // mid-loop (not merely before it started) — the faithful "stuck in the retry loop" scenario.
    let readEntered!: () => void;
    const enteredFirstRead = new Promise<void>((res) => {
      readEntered = res;
    });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((res) => {
      releaseRead = res;
    });
    let leaderReads = 0;
    // Leader shape == our shape (both hold the full 5.0 SOL) ⇒ NO deficit ⇒ the loop keeps retrying: a genuinely
    // stuck resync that would otherwise burn the whole retry budget.
    vi.mocked(readLeaderPositionShape).mockImplementation(async (_c, _p, _o, position) => {
      if (position === P_LEADER_POS) {
        leaderReads++;
        if (leaderReads === 1) {
          readEntered();
          await readGate; // hold the resync inside the first read until the close is queued
        }
      }
      return shape(1_000n, 2_500_000_000n);
    });
    vi.mocked(buildCloseTx).mockResolvedValue([new Transaction()]);

    rt.onEvent(resyncEvent('resync-146-preempt'), 'ws', P_LEADER, 1); // resync enters the loop, blocks in read #1
    await enteredFirstRead; // the resync is now provably mid-loop
    rt.onEvent(closeEvent('resync-146-preempt'), 'ws', P_LEADER, 2); // a close is queued BEHIND the in-flight resync
    releaseRead(); // let read #1 return — the next loop-top check must see the pending close and bail

    await waitFor(
      () => Promise.resolve(published.filter((c) => c.kind === 'close').length),
      (n) => n > 0,
    );
    // The close WAS handled (published) — promptly, not after the retry budget.
    expect(published.some((c) => c.kind === 'close')).toBe(true);
    // The preempted resync published NO reshape op and wrote NO size (it bailed before the build/publish/size block).
    expect(published.some((c) => c.kind === 'remove' || c.kind === 'add' || c.kind === 'buy')).toBe(
      false,
    );
    expect(updateSize).not.toHaveBeenCalled();
    // It bailed EARLY: it never approached RESYNC_READ_RETRIES (=8, i.e. 9 leader reads) worth of reads.
    expect(leaderReads).toBeLessThanOrEqual(2);
    vi.mocked(buildCloseTx).mockReset();
    vi.mocked(readLeaderPositionShape).mockReset();
  });

  it('a normal resync with NO pending close still runs its loop and records the shrunk size', async () => {
    // Guard (no regression): the preempt gate must not alter the normal resync path. With no close queued, the loop
    // finds the leader de-risk, publishes the shrink (removes land synchronously), and records the shrunk size. A
    // fix that bailed unconditionally — or left the marker set — would fail here.
    const { rt, published } = await boot('resync-146-normal');
    const updateSize = vi.spyOn(rt.store, 'updateSize');
    // Leader de-risked to 0.5 SOL/bin (total 1.0); we still hold 2.5 SOL/bin ⇒ a real deficit on the first read.
    vi.mocked(readLeaderPositionShape).mockImplementation(async (_c, _p, _o, position) =>
      position === P_LEADER_POS ? shape(1_000n, 500_000_000n) : shape(1_000n, 2_500_000_000n),
    );
    vi.mocked(buildRemovePartial).mockImplementation(async () => [new Transaction()]);

    rt.onEvent(resyncEvent('resync-146-normal'), 'ws', P_LEADER, 1);
    await waitFor(
      () => Promise.resolve(updateSize.mock.calls.length),
      (n) => n > 0,
    );
    expect(published.some((c) => c.kind === 'remove')).toBe(true); // the shrink published
    const recorded = updateSize.mock.calls.find((c) => c[0] === P_LEADER_POS)?.[1];
    expect(recorded).toBeCloseTo(1); // copyRatio 1.0 × leader 1.0 SOL, capped at 5
    vi.mocked(buildRemovePartial).mockReset();
    vi.mocked(readLeaderPositionShape).mockReset();
  });
});

describe('UserRuntime — a RESYNC nets against the IN-FLIGHT reshape, not the stale read (finding #121)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const F_LEADER = Keypair.generate().publicKey.toBase58();
  const F_LEADER_POS = Keypair.generate().publicKey.toBase58();
  const F_OUR_POS = Keypair.generate().publicKey.toBase58();
  const F_POOL = Keypair.generate().publicKey.toBase58();
  const F_MINT = Keypair.generate().publicKey.toBase58();
  const F_BLOCKHASH = Keypair.generate().publicKey.toBase58(); // a valid 32-byte base58 blockhash so a tx serializes

  // Both legs on each bin over [0,1] ⇒ readStableShape settles on the FIRST poll (no inner retry).
  const shape = (xRaw: bigint, ySol: bigint) => ({
    positionPubkey: '__resync_121__',
    activeBinId: 0,
    lowerBinId: 0,
    upperBinId: 1,
    perBin: [
      { binId: 0, x: xRaw, y: ySol },
      { binId: 1, x: xRaw, y: ySol },
    ],
  });

  const sharedF: SharedBrainDeps = {
    ...shared,
    poolReader: {
      loadPoolMeta: async (pool: string) =>
        pool === F_POOL
          ? ({ solSide: 'Y', binStep: 20, mintX: F_MINT, mintY: WSOL } as LoadedPoolMeta)
          : null,
    } as unknown as OnchainPoolMetaReader,
  };

  // ratio 100% (copyRatio 1.0), twoSidedMode off (pure SOL-leg reshape, no Jupiter), infiniteAdd on so a leader ADD
  // routes a tracked position to resync. maxTradeSizeSol 20 ⇒ the factor is never capped for the ≤10-SOL leaders here.
  const cfg = () => ({
    ...CONFIG_DEFAULTS,
    user: {
      ...CONFIG_DEFAULTS.user,
      twoSidedMode: 'off' as const,
      infiniteAdd: true,
      sizing: { ...CONFIG_DEFAULTS.user.sizing, tradeRatioPct: 100, maxTradeSizeSol: 20 },
    },
    leaders: [{ address: F_LEADER, enabled: true, maxTotalExposureSol: null, overrides: {} }],
  });

  /** Boot a runtime whose bus CAPTURES published commands, with a valid blockhash cache, and open a full 5.0-SOL mirror. */
  async function boot(userId: string) {
    const published: Array<Record<string, unknown>> = [];
    const conn = new Connection('http://127.0.0.1:1');
    vi.spyOn(conn, 'getSlot').mockResolvedValue(1_000); // slots() resolves so handleResync reaches the build/publish tail
    const blockhashCache = new BlockhashCache(async () => ({
      blockhash: F_BLOCKHASH,
      lastValidBlockHeight: 0,
    }));
    await blockhashCache.start();
    const bus = {
      publish: async (_s: string, _h: string, _k: string, payload: Record<string, unknown>) => {
        published.push(payload);
        return 'sid';
      },
    } as unknown as RedisBus;
    const rt = await createUserRuntime({ ...sharedF, conn, bus, blockhashCache }, userId, {
      ...opts,
      leader: F_LEADER,
      initialConfig: cfg(),
    });
    rt.registry.open({
      leaderPosition: F_LEADER_POS,
      leaderAddress: F_LEADER,
      ourPosition: F_OUR_POS,
      pool: F_POOL,
      nonSolSymbol: 'TKN',
      nonSolMint: F_MINT,
      sizeSol: 5, // we hold the full size, in sync with the leader's original 5.0 SOL (2.5/bin over 2 bins)
      lowerBin: 0,
      upperBin: 1,
      openedAt: Date.now(),
    });
    await rt.store.saveOpen(rt.registry.get(F_LEADER_POS)!);
    return { rt, published };
  }

  const removeEvent = (userId: string, n: number) => ({
    signature: `sig-121-rm-${userId}-${n}`,
    blockTime: 1,
    instruction: 'RemoveLiquidityByRange2',
    depositSol: 0,
    depositTokenRaw: 0,
    withdrawSol: 2, // > RESYNC_MIN_CHANGE_SOL → a real shrink → resync
    claimSol: 0,
    closed: false,
    pool: F_POOL,
    position: F_LEADER_POS,
    nonSolMint: F_MINT,
    nonSolSymbol: 'TKN',
  });

  const addEvent = (userId: string, n: number) => ({
    signature: `sig-121-add-${userId}-${n}`,
    blockTime: 1,
    instruction: 'AddLiquidityByStrategy2',
    depositSol: 2, // a leader ADD → routes the tracked position to resync (infiniteAdd on)
    depositTokenRaw: 0,
    withdrawSol: 0,
    claimSol: 0,
    closed: false,
    pool: F_POOL,
    position: F_LEADER_POS,
    nonSolMint: F_MINT,
    nonSolSymbol: 'TKN',
  });

  it('a rapid leader remove→add does NOT strand the copy ~50% UNDER: the 2nd resync nets against the in-flight target', async () => {
    // WHY (#121, money): the leader de-risks then re-adds within one settle window. The 1st resync publishes the remove
    // (which NEVER confirms back to the brain — dispatch-executed has no 'remove' branch), so when the 2nd resync runs
    // OUR on-chain read still shows the PRE-shrink shape. A naive resync sees leader==our → NO-OP; once the pending
    // remove lands the copy sits ~50% UNDER the leader until some later event happens to re-net. Netting the 2nd resync
    // against the 1st reshape's TARGET re-grows it NOW. FAILS if the in-flight netting regresses: the 2nd resync
    // publishes no add and the size stays stranded at ~2.0.
    const { rt, published } = await boot('resync-121-under');
    vi.mocked(buildRemovePartial).mockImplementation(async () => [new Transaction()]);
    vi.mocked(buildAddByWeight).mockImplementation(async () => new Transaction());
    let leaderYsol = 1_000_000_000n; // event 1: leader de-risks to 1.0 SOL/bin (total 2.0)
    // OUR on-chain read STAYS at the pre-shrink 2.5 SOL/bin for BOTH resyncs — the 1st reshape's remove has not landed.
    vi.mocked(readLeaderPositionShape).mockImplementation(async (_c, _p, _o, position) =>
      position === F_LEADER_POS ? shape(1_000n, leaderYsol) : shape(1_000n, 2_500_000_000n),
    );

    rt.onEvent(removeEvent('resync-121-under', 1), 'ws', F_LEADER, 1); // resync #1: shrink to 2.0 + stash the target
    await waitFor(
      () => Promise.resolve(rt.registry.get(F_LEADER_POS)?.sizeSol ?? 5),
      (s) => s < 3, // resync #1 recorded the shrunk size (target 2.0) → it published and stashed
    );
    expect(published.some((c) => c.kind === 'remove')).toBe(true);

    leaderYsol = 2_500_000_000n; // event 2: leader adds back to the ORIGINAL 2.5 SOL/bin (total 5.0)
    rt.onEvent(addEvent('resync-121-under', 2), 'ws', F_LEADER, 2); // resync #2: must re-grow to 5.0
    await waitFor(
      () => Promise.resolve(published.filter((c) => c.kind === 'add').length),
      (n) => n > 0,
    );
    expect(published.some((c) => c.kind === 'add')).toBe(true); // re-grew (vs a stale-read NO-OP)
    expect(rt.registry.get(F_LEADER_POS)?.sizeSol).toBeCloseTo(5); // back in sync with the leader — not stranded at 2.0

    vi.mocked(buildRemovePartial).mockReset();
    vi.mocked(buildAddByWeight).mockReset();
    vi.mocked(readLeaderPositionShape).mockReset();
  });

  it('a rapid leader add→remove does NOT leave the copy ~2× OVER: the 2nd resync nets against the in-flight target', async () => {
    // WHY (#121, money — the dangerous inverse): the leader adds then de-risks within one window. The 1st resync
    // publishes the add (in flight, not landed); the 2nd resync's stale on-chain read still shows the PRE-add shape ==
    // the re-shrunk leader → NO-OP; once the add lands the copy sits ~2× OVER the leader (riding size the leader shed).
    // Netting the 2nd resync against the 1st reshape's TARGET publishes the shrink NOW. FAILS if the netting regresses.
    const { rt, published } = await boot('resync-121-over');
    vi.mocked(buildAddByWeight).mockImplementation(async () => new Transaction());
    vi.mocked(buildRemovePartial).mockImplementation(async () => [new Transaction()]);
    let leaderYsol = 5_000_000_000n; // event 1: leader grows to 5.0 SOL/bin (total 10.0)
    // OUR on-chain read STAYS at the pre-grow 2.5 SOL/bin for BOTH resyncs — the 1st reshape's add has not landed.
    vi.mocked(readLeaderPositionShape).mockImplementation(async (_c, _p, _o, position) =>
      position === F_LEADER_POS ? shape(1_000n, leaderYsol) : shape(1_000n, 2_500_000_000n),
    );

    rt.onEvent(addEvent('resync-121-over', 1), 'ws', F_LEADER, 1); // resync #1: grow to 10.0 + stash the target
    await waitFor(
      () => Promise.resolve(rt.registry.get(F_LEADER_POS)?.sizeSol ?? 5),
      (s) => s > 8, // resync #1 recorded the grown size (target 10.0) → it published and stashed
    );
    expect(published.some((c) => c.kind === 'add')).toBe(true);

    leaderYsol = 2_500_000_000n; // event 2: leader de-risks back to 2.5 SOL/bin (total 5.0)
    rt.onEvent(removeEvent('resync-121-over', 2), 'ws', F_LEADER, 2); // resync #2: must shrink back to 5.0
    await waitFor(
      () => Promise.resolve(published.filter((c) => c.kind === 'remove').length),
      (n) => n > 0,
    );
    expect(published.some((c) => c.kind === 'remove')).toBe(true); // shrank (vs a stale-read NO-OP)
    expect(rt.registry.get(F_LEADER_POS)?.sizeSol).toBeCloseTo(5); // back in sync — not left ~2× over at 10.0

    vi.mocked(buildAddByWeight).mockReset();
    vi.mocked(buildRemovePartial).mockReset();
    vi.mocked(readLeaderPositionShape).mockReset();
  });

  it('a resync with NO in-flight reshape is UNCHANGED — it nets against the on-chain read', async () => {
    // Guard (no regression): the in-flight netting must be INERT when nothing is in flight. A single de-risk with no
    // prior reshape nets against the REAL on-chain read (our 2.5/bin vs leader 1.0/bin → shrink to 2.0), exactly as
    // before the fix. FAILS if the override fired spuriously (e.g. off a missing/empty target) and mis-planned.
    const { rt, published } = await boot('resync-121-inert');
    vi.mocked(buildRemovePartial).mockImplementation(async () => [new Transaction()]);
    vi.mocked(readLeaderPositionShape).mockImplementation(async (_c, _p, _o, position) =>
      position === F_LEADER_POS ? shape(1_000n, 1_000_000_000n) : shape(1_000n, 2_500_000_000n),
    );

    rt.onEvent(removeEvent('resync-121-inert', 1), 'ws', F_LEADER, 1);
    await waitFor(
      () => Promise.resolve(rt.registry.get(F_LEADER_POS)?.sizeSol ?? 5),
      (s) => s < 3,
    );
    expect(published.some((c) => c.kind === 'remove')).toBe(true);
    expect(rt.registry.get(F_LEADER_POS)?.sizeSol).toBeCloseTo(2); // copyRatio 1.0 × leader 2.0 SOL, on-chain-netted

    vi.mocked(buildRemovePartial).mockReset();
    vi.mocked(readLeaderPositionShape).mockReset();
  });
});

describe('UserRuntime — a recurring residual SELL is not permanently idempotency-rejected (idx9/idx43)', () => {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const S_LEADER = Keypair.generate().publicKey.toBase58();
  const S_POOL = Keypair.generate().publicKey.toBase58();
  const S_MINT = Keypair.generate().publicKey.toBase58();
  const S_BLOCKHASH = Keypair.generate().publicKey.toBase58();
  const RESIDUAL = 1_000_000n;

  async function bootSell(userId: string) {
    const published: Array<Record<string, unknown>> = [];
    const conn = new Connection('http://127.0.0.1:1');
    vi.spyOn(conn, 'getSlot').mockResolvedValue(1_000); // slots() resolves so publishSell reaches the publish
    const blockhashCache = new BlockhashCache(async () => ({
      blockhash: S_BLOCKHASH,
      lastValidBlockHeight: 0,
    }));
    await blockhashCache.start();
    const bus = {
      publish: async (_s: string, _h: string, _k: string, payload: Record<string, unknown>) => {
        published.push(payload);
        return 'sid';
      },
    } as unknown as RedisBus;
    const rt = await createUserRuntime({ ...shared, conn, bus, blockhashCache }, userId, {
      ...opts,
      leader: S_LEADER, // ⇒ bootLeader = S_LEADER (the sell eventKey's prefix)
    });
    return { rt, published };
  }

  it('the SAME residual re-sold in a LATER epoch derives a FRESH commandId (a stuck token can retry), while two attempts in ONE epoch share it (in-flight dedup intact)', async () => {
    // WHY (idx9/idx43, money — a stranded token): a sell never forceReclaims, so a residual whose earlier sell FAILED
    // recurs with the SAME (pool, mint, amount). Without the epoch discriminator it re-derives the SAME commandId and
    // the vault's (user, command_id) idempotency PERMANENTLY rejects it → the non-SOL token is stuck on the wallet
    // forever. The published eventKey now folds a time-epoch: a LATER window ⇒ a fresh commandId (the retry lands),
    // while two attempts INSIDE one window keep the SAME commandId so a concurrent/in-flight re-attempt still dedups
    // (no wasteful double broadcast). This FAILS if the discriminator regresses (all three commandIds collapse to one).
    vi.mocked(getJupiterQuote).mockResolvedValue({
      inputMint: S_MINT,
      outputMint: SOL_MINT,
      inAmount: RESIDUAL.toString(),
      outAmount: '5000000000', // 5 SOL out — comfortably above minSellOutLamports so the sell publishes
      raw: {},
    });
    vi.mocked(buildJupiterSwapTx).mockResolvedValue('selltx-b64');
    const { rt, published } = await bootSell('sell-epoch-user');

    // Anchor to the CURRENT epoch's start so no blockhash/staleness clock logic trips on a far-past mock.
    const baseEpoch = Math.floor(Date.now() / SELL_COMMAND_EPOCH_MS);
    const t0 = baseEpoch * SELL_COMMAND_EPOCH_MS;
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(t0); // epoch N
    expect(await rt.publishSell(S_MINT, RESIDUAL, S_POOL, 'sweep')).toBe(true);
    nowSpy.mockReturnValue(t0 + 1); // still epoch N (a concurrent / in-flight re-attempt)
    expect(await rt.publishSell(S_MINT, RESIDUAL, S_POOL, 'sweep')).toBe(true);
    nowSpy.mockReturnValue(t0 + SELL_COMMAND_EPOCH_MS); // epoch N+1 (a genuine later retry)
    expect(await rt.publishSell(S_MINT, RESIDUAL, S_POOL, 'sweep')).toBe(true);

    const sells = published.filter((c) => c.kind === 'sell');
    expect(sells).toHaveLength(3);
    const cmds = sells.map((c) => c.commandId as string);
    expect(cmds[0]).toBe(cmds[1]); // same epoch → SAME commandId ⇒ the vault dedups (no double broadcast)
    expect(cmds[2]).not.toBe(cmds[0]); // later epoch → FRESH commandId ⇒ the recurring residual retries
    // The discriminator lives in the eventKey (the vault re-derives commandId == deriveCommandId(userId, eventKey)).
    const keys = sells.map((c) => c.eventKey as string);
    expect(keys[0]).toBe(`${S_LEADER}:${S_POOL}:sweep:${S_MINT}:${RESIDUAL}:${baseEpoch}`);
    expect(keys[2]).toBe(`${S_LEADER}:${S_POOL}:sweep:${S_MINT}:${RESIDUAL}:${baseEpoch + 1}`);

    nowSpy.mockRestore();
    vi.mocked(getJupiterQuote).mockReset();
    vi.mocked(buildJupiterSwapTx).mockReset();
  });
});

describe('UserRuntime — a BUILD-phase handler throw is observable as system.mirror_error (idx7)', () => {
  it('a close whose buildCloseTx THROWS emits the typed system.mirror_error with context — not just a bare log line', async () => {
    // WHY (idx7, observability): a bus-publish failure is journaled (lifecycle.publish_failed), but a BUILD-phase throw
    // (before publish) was swallowed with ONLY a log line — invisible to the feed/audit. It now ALSO emits the typed
    // system.mirror_error carrying the real leader/position so a build failure is observable. Control flow is unchanged
    // (still swallowed → the position queue keeps draining). This FAILS if the typed emit regresses to a bare log.
    const U = 'mirror-error-user';
    const M_LEADER = Keypair.generate().publicKey.toBase58();
    const M_POOL = Keypair.generate().publicKey.toBase58();
    const M_POS = Keypair.generate().publicKey.toBase58();
    const M_OUR = Keypair.generate().publicKey.toBase58();
    const M_MINT = Keypair.generate().publicKey.toBase58();
    const rt = await createUserRuntime({ ...shared }, U, { ...opts, leader: M_LEADER });
    rt.registry.open({
      leaderPosition: M_POS,
      leaderAddress: M_LEADER,
      ourPosition: M_OUR,
      pool: M_POOL,
      nonSolSymbol: 'TKN',
      nonSolMint: M_MINT,
      sizeSol: 1,
      lowerBin: 0,
      upperBin: 1,
      openedAt: Date.now(),
    });
    vi.mocked(buildCloseTx).mockRejectedValueOnce(new Error('build boom')); // the BUILD throws before any publish
    rt.onEvent(
      {
        signature: 'sig-mirror-err',
        blockTime: 1,
        instruction: 'ClosePosition',
        depositSol: 0,
        depositTokenRaw: 0,
        withdrawSol: 0,
        claimSol: 0,
        closed: true,
        pool: M_POOL,
        position: M_POS,
        nonSolMint: M_MINT,
        nonSolSymbol: 'TKN',
      },
      'ws',
      M_LEADER,
      1,
    );
    const rows = await waitFor(
      () =>
        db
          .select({ code: schema.copyJournal.code, leader: schema.copyJournal.leader })
          .from(schema.copyJournal)
          .where(eq(schema.copyJournal.userId, U)),
      (r) => r.some((x) => x.code === 'system.mirror_error'),
    );
    // the build failure is journaled as the typed code AND attributed to the real (event) leader.
    expect(rows.some((r) => r.code === 'system.mirror_error' && r.leader === M_LEADER)).toBe(true);
    vi.mocked(buildCloseTx).mockReset();
  });
});

describe('UserRuntime — a cancelled multi-tx open names the REAL leader, not bootLeader (idx10)', () => {
  it('cancelPendingOpen labels the open-cancelled failsafe with the STASH leader (3b fan-out), not the boot leader', async () => {
    // WHY (idx10): the open-cancelled failsafe hardcoded bootLeader, mislabelling a fan-out leader's cancelled open.
    // The originating leader is threaded on the in-flight open stash — cancelPendingOpen now reads it so the row is
    // attributable to the leader that actually opened. This FAILS if the label regresses to the boot leader.
    const U = 'cancel-leader-user';
    const OTHER_LEADER = Keypair.generate().publicKey.toBase58();
    const POS = Keypair.generate().publicKey.toBase58();
    const POOL = Keypair.generate().publicKey.toBase58();
    const rt = await createUserRuntime({ ...shared }, U, { ...opts, leader: LEADER }); // bootLeader = LEADER
    // Seed an in-flight two-sided open stash for OTHER_LEADER (a fan-out leader ≠ the boot leader).
    const maps = rt.pendingOpenMapsView().twoSidedOpens as unknown as Map<string, unknown>;
    maps.set('cmd-cancel-x', { e: { position: POS, pool: POOL }, leader: OTHER_LEADER });
    rt.cancelPendingOpen(POS, POOL);
    const rows = await waitFor(
      () =>
        db
          .select({ code: schema.copyJournal.code, leader: schema.copyJournal.leader })
          .from(schema.copyJournal)
          .where(eq(schema.copyJournal.userId, U)),
      (r) => r.some((x) => x.code === 'failsafe.activated'),
    );
    expect(rows.find((r) => r.code === 'failsafe.activated')?.leader).toBe(OTHER_LEADER);
  });
});
