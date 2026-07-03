import { PGlite } from '@electric-sql/pglite';
import { Connection, Keypair } from '@solana/web3.js';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { deriveCommandId } from '@/copybot/command-id';
import type { HeartbeatStore } from '@/copybot/heartbeat-store';
import { CONFIG_DEFAULTS } from '@/domain/copybot/config';
import type { TokenSnapshot } from '@/domain/copybot/filters';
import { LeaderPositionTracker } from '@/domain/copybot/leader-position';
import { TtlCache } from '@/domain/copybot/ttl-cache';
import type { ControlChannel } from '@/infrastructure/bus/control-channel';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import type { Database } from '@/infrastructure/persistence/database';
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

import { createUserRuntime, type SharedBrainDeps } from './user-runtime';

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
  poolReader: { loadPoolMeta: async () => null } as unknown as OnchainPoolMetaReader,
  tokenMeta: {} as HeliusTokenMetadataGateway,
  blockhashCache: new BlockhashCache(async () => ({ blockhash: 'x', lastValidBlockHeight: 0 })),
  priorityFeeOracle: { get: () => null } as unknown as PriorityFeeOracle,
  filterDeps: { jupiterToken: async () => null, snapshotCache: new TtlCache<TokenSnapshot>(1000) },
  control: {} as ControlChannel,
  heartbeat: {} as HeartbeatStore,
  tracker: new LeaderPositionTracker(),
  recentlyPublishedClose: new Map(),
  inFlightBuyMints: new Map(),
  pendingSellMints: new Map(),
  nextJitoTipSeed: () => 0,
  jupiterBaseUrl: 'http://127.0.0.1:1',
  jitoEnabledEnv: undefined,
  priorityFeeOracleEnv: undefined,
  alertWebhookUrl: undefined,
};

const opts = {
  ownerPk: OWNER,
  balanceOf: () => 10,
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
