import { PGlite } from '@electric-sql/pglite';
import type { Connection } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import type { SignRequest } from '@/domain/copybot/contracts';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import type { Database } from '@/infrastructure/persistence/database';
import { PositionLedgerRepository } from '@/infrastructure/persistence/position-ledger-repository';
import * as schema from '@/infrastructure/persistence/schema';
import { executions, positionLedger } from '@/infrastructure/persistence/schema';
import { ConfirmWorker } from './confirm-worker';
import { claimExecution } from './idempotency';
import { type Ctx, recoveryPreCheck, type SubmittedPublishCtx } from './process-command';

// Fresh in-memory Postgres (PGlite) with the real Drizzle migrations applied — exercises the executions row
// (state machine + publish_ctx) exactly as production creates it.
const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();
const log = pino({ level: 'silent' });

const LVBH = 1_000; // lastValidBlockHeight persisted with each seeded broadcast
let seq = 0; // per-test unique ids so the shared PGlite never collides across cases

function publishCtxOf(kind: SubmittedPublishCtx['kind'] = 'close'): SubmittedPublishCtx {
  return {
    kind,
    pool: `POOL_${seq}`,
    positionPubkey: `POS_${seq}`,
    owner: `OWNER_${seq}`,
    sizeSol: 0.1,
    issuedAtMs: Date.now(),
  };
}

/** Seed a durable broadcast row (state 'submitted') as `markSubmitted` leaves it before the confirmation. */
async function seedSubmitted(opts: {
  userId?: string;
  signature: string;
  publish?: SubmittedPublishCtx | null;
}): Promise<{
  userId: string;
  commandId: string;
  signature: string;
  publish: SubmittedPublishCtx | null;
}> {
  seq++;
  const userId = opts.userId ?? `user-${seq}`;
  const commandId = `cmd-${seq}`;
  const publish = opts.publish === undefined ? publishCtxOf() : opts.publish;
  await db.insert(executions).values({
    userId,
    commandId,
    eventKey: `ek-${seq}`,
    state: 'submitted',
    deadlineSlot: 1_000_000,
    signature: opts.signature,
    lastValidBlockHeight: LVBH,
    publishCtx: publish,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return { userId, commandId, signature: opts.signature, publish };
}

const rowOf = async (userId: string, commandId: string) =>
  (
    await db
      .select()
      .from(executions)
      .where(and(eq(executions.userId, userId), eq(executions.commandId, commandId)))
  )[0];

type Status = { err?: unknown; confirmationStatus?: string } | null;
/** A minimal getTransaction response the ledger writer reads (owner delta from static keys + pre/post balances). */
type TxResponse = {
  meta: { preBalances: number[]; postBalances: number[] } | null;
  transaction: { message: { staticAccountKeys?: Array<{ toBase58: () => string }> } };
} | null;
/** A conn whose batch status read + block height are scripted; `getSignatureStatus` serves the recovery path.
 *  `getTransaction` (Inc.4d) is scripted per-sig for the position-ledger writer — defaults to null (no row). */
function connOf(opts: {
  statuses: (sig: string) => Status;
  blockHeight: number;
  transactions?: (sig: string) => TxResponse;
}): {
  conn: Connection;
  getStatuses: ReturnType<typeof vi.fn>;
  getTx: ReturnType<typeof vi.fn>;
} {
  const getStatuses = vi.fn(async (sigs: string[]) => ({
    value: sigs.map((s) => opts.statuses(s)),
  }));
  const getTx = vi.fn(async (sig: string) => (opts.transactions ? opts.transactions(sig) : null));
  const conn = {
    getSignatureStatuses: getStatuses,
    getSignatureStatus: async (s: string) => ({ value: opts.statuses(s) }),
    getBlockHeight: async () => opts.blockHeight,
    getTransaction: getTx,
  } as unknown as Connection;
  return { conn, getStatuses, getTx };
}

/** A synthetic getTransaction response placing `owner` at static index 0 with the given lamport delta. */
function txWithOwnerDelta(owner: string, pre: number, post: number): TxResponse {
  return {
    meta: { preBalances: [pre, 1, 1], postBalances: [post, 1, 1] },
    transaction: { message: { staticAccountKeys: [{ toBase58: () => owner }] } },
  };
}

let bus: RedisBus;
let events: CopyEvents;
beforeEach(() => {
  bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
  events = { emit: vi.fn() } as unknown as CopyEvents;
});

const workerOf = (conn: Connection): ConfirmWorker =>
  new ConfirmWorker({
    conn,
    db,
    bus,
    events,
    ledger: new PositionLedgerRepository(db),
    hmacKey: 'k',
    log,
  });

const ledgerRowsOf = async (userId: string, ourPosition: string) =>
  db
    .select()
    .from(positionLedger)
    .where(and(eq(positionLedger.userId, userId), eq(positionLedger.ourPosition, ourPosition)));

const track = (w: ConfirmWorker, s: Awaited<ReturnType<typeof seedSubmitted>>): void =>
  w.track({
    userId: s.userId,
    commandId: s.commandId,
    signature: s.signature,
    lastValidBlockHeight: LVBH,
    publish: s.publish,
  });

describe('ConfirmWorker — ONE batched status read confirms every in-flight broadcast (ULTRACODE #22/#31)', () => {
  it('two users confirm in a single getSignatureStatuses call → both landed + both ev:executed published', async () => {
    // WHY: the old inline confirm held ONE lane per tx for up to 45s — user B's CLOSE waited behind user A's
    // unconfirmed open. The worker replaces N serial waits with one shared batch: no lane is ever held, and the
    // publish payload is byte-for-byte what the inline path sent (the brain's confirm routing must not change).
    const a = await seedSubmitted({ signature: 'SIG_A' });
    const b = await seedSubmitted({ signature: 'SIG_B' });
    const { conn, getStatuses } = connOf({
      statuses: () => ({ confirmationStatus: 'confirmed' }),
      blockHeight: 500,
    });
    const w = workerOf(conn);
    track(w, a);
    track(w, b);
    await w.tick();
    expect(getStatuses).toHaveBeenCalledTimes(1); // ONE batch for all users — not one poll loop per tx
    expect(getStatuses.mock.calls[0]?.[0]).toEqual(['SIG_A', 'SIG_B']);
    expect((await rowOf(a.userId, a.commandId))?.state).toBe('landed');
    expect((await rowOf(b.userId, b.commandId))?.state).toBe('landed');
    expect(bus.publish).toHaveBeenCalledTimes(2);
    expect(vi.mocked(bus.publish).mock.calls[0]?.[3]).toEqual({
      commandId: a.commandId,
      kind: 'close',
      sig: 'SIG_A',
      pool: a.publish?.pool,
      positionPubkey: a.publish?.positionPubkey,
      owner: a.publish?.owner,
      userId: a.userId, // tenant routing (3b) survives the async split
    });
    expect(w.inflightCount).toBe(0);
    // The observability landing row is still emitted (sign.landed) — the feed sees the same lifecycle.
    expect(vi.mocked(events.emit).mock.calls.map((c) => c[0])).toContain('sign.landed');
  });

  it('not found + blockhash still alive → keeps polling (no finalize, no publish, still in flight)', async () => {
    // WHY: the tx may still land under a live blockhash; failing it now could re-drive a close that then lands
    // TWICE, and landing it now would be a phantom success.
    const s = await seedSubmitted({ signature: 'SIG_WAIT' });
    const { conn } = connOf({ statuses: () => null, blockHeight: LVBH - 100 });
    const w = workerOf(conn);
    track(w, s);
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('submitted');
    expect(w.inflightCount).toBe(1);
    expect(bus.publish).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('EXPIRY (not found + height > lastValidBlockHeight) → failed (re-claimable) + the pinned alert pair, NO publish', async () => {
    // WHY (no-dormant-position): a broadcast the chain never saw past its blockhash expiry can provably never
    // land. It must become 'failed' — the ONLY re-claimable state — so the reconcile/orphan backstop re-drives the
    // close, and the operator still gets the pinned "VERIFY/CLOSE MANUALLY" alert the inline path emitted.
    const s = await seedSubmitted({ signature: 'SIG_EXPIRED' });
    const { conn } = connOf({ statuses: () => null, blockHeight: LVBH + 1 });
    const w = workerOf(conn);
    track(w, s);
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('failed');
    expect(bus.publish).not.toHaveBeenCalled(); // never a phantom ev:executed
    const codes = vi.mocked(events.emit).mock.calls.map((c) => c[0]);
    expect(codes).toContain('sign.land_failed');
    expect(codes).toContain('lifecycle.close_failed'); // kind-precise pinned alert, from the persisted context
    // …and the failed row is re-claimable (the reconcile re-publish can retry the command):
    expect(await claimExecution(db, s.userId, s.commandId, 'ek', 999, Date.now())).toBe(true);
  });

  it('on-chain ERROR → failed (atomic revert — nothing applied), NO publish', async () => {
    const s = await seedSubmitted({ signature: 'SIG_ERR' });
    const { conn } = connOf({ statuses: () => ({ err: 'InstructionError' }), blockHeight: 500 });
    const w = workerOf(conn);
    track(w, s);
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('failed');
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('a publish failure AFTER a confirmed land stays landed — never re-lands, never throws (terminal scope)', async () => {
    // WHY (the money-path guarantee, moved from the inline path): once confirmed the on-chain action is
    // irreversible; a Redis blip on ev:executed must degrade to the reconcile backstop, not corrupt the state.
    const s = await seedSubmitted({ signature: 'SIG_BLIP' });
    bus = {
      publish: vi.fn(async () => {
        throw new Error('redis blip');
      }),
    } as unknown as RedisBus;
    const { conn } = connOf({
      statuses: () => ({ confirmationStatus: 'finalized' }),
      blockHeight: 500,
    });
    const w = workerOf(conn);
    track(w, s);
    await expect(w.tick()).resolves.toBeUndefined(); // swallowed
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('landed');
  });
});

describe('ConfirmWorker — restart durability (`loadPending` re-reads the submitted rows)', () => {
  it('a crash after ACK loses nothing: loadPending resumes the row and publishes from its persisted context', async () => {
    // WHY: past the broadcast the cmd:sign message may be ACKed (gone from the PEL) — the executions row is the
    // ONLY recovery state. A fresh worker must confirm AND publish a faithful ev:executed purely from the row.
    const s = await seedSubmitted({ signature: 'SIG_RESUME' });
    const { conn } = connOf({
      statuses: () => ({ confirmationStatus: 'confirmed' }),
      blockHeight: 500,
    });
    const w = workerOf(conn); // fresh instance — nothing tracked in memory
    expect(await w.loadPending()).toBeGreaterThanOrEqual(1);
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('landed');
    const published = vi
      .mocked(bus.publish)
      .mock.calls.find((c) => (c[3] as { sig?: string }).sig === 'SIG_RESUME');
    expect(published?.[3]).toMatchObject({
      commandId: s.commandId,
      kind: 'close',
      pool: s.publish?.pool,
      positionPubkey: s.publish?.positionPubkey,
      owner: s.publish?.owner,
      userId: s.userId,
    });
  });

  it('a legacy submitted row WITHOUT publish context is finalized landed but never publishes a degraded event', async () => {
    // WHY: a half-true ev:executed (missing kind/position) could misroute the brain's confirm handling — worse
    // than none. The landing is recorded; the reconcile backstop picks up the position change.
    const s = await seedSubmitted({ signature: 'SIG_LEGACY', publish: null });
    const { conn } = connOf({
      statuses: () => ({ confirmationStatus: 'confirmed' }),
      blockHeight: 500,
    });
    const w = workerOf(conn);
    await w.loadPending();
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('landed');
    const sigs = vi.mocked(bus.publish).mock.calls.map((c) => (c[3] as { sig?: string }).sig);
    expect(sigs).not.toContain('SIG_LEGACY');
  });
});

describe('ConfirmWorker ⇄ recovery — the exactly-once landing protocol under concurrency', () => {
  /** A minimal recovery Ctx + SignRequest for `recoveryPreCheck` over a seeded row. */
  function recoveryFixture(
    s: Awaited<ReturnType<typeof seedSubmitted>>,
    conn: Connection,
  ): { ctx: Ctx; sr: SignRequest } {
    const ctx = { conn, db, bus, events, hmacKey: 'k', log } as unknown as Ctx;
    const sr = {
      userId: s.userId,
      commandId: s.commandId,
      eventKey: `ek-${seq}`,
      kind: 'close',
      pool: s.publish?.pool ?? 'POOL',
      positionPubkey: s.publish?.positionPubkey ?? 'POS',
      owner: s.publish?.owner ?? 'OWNER',
      sizeSol: 0.1,
      issuedAtMs: Date.now(),
    } as unknown as SignRequest;
    return { ctx, sr };
  }

  it('★ worker confirm RACING the boot-recovery re-delivery of the same command publishes ev:executed EXACTLY once', async () => {
    // WHY (the 3c race): a crash between markSubmitted and the ACK leaves BOTH a durable 'submitted' row (the
    // worker re-reads it) and the PEL message (boot recovery re-delivers it). Both paths see the tx confirmed and
    // both try to resolve the same row — the conditional finalize (state still 'submitted' AND the signature still
    // this broadcast) elects one winner; the loser must publish NOTHING. A double ev:executed would double-drive
    // the brain's confirm handling (e.g. a residual sell fired twice).
    const s = await seedSubmitted({ signature: 'SIG_RACE' });
    const { conn } = connOf({
      statuses: () => ({ confirmationStatus: 'confirmed' }),
      blockHeight: 500,
    });
    const w = workerOf(conn);
    track(w, s);
    const { ctx, sr } = recoveryFixture(s, conn);
    const [, verdict] = await Promise.all([w.tick(), recoveryPreCheck(ctx, sr)]);
    expect(verdict).toEqual({ ok: true, kind: 'close' }); // recovery acks the terminal outcome either way
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('landed');
    expect(bus.publish).toHaveBeenCalledTimes(1); // ← the exactly-once assertion
  });

  it('★ a RE-CLAIMED command is untouchable by its stale broadcast (signature-pinned finalize, no spurious alert)', async () => {
    // WHY: at boot the worker re-tracks a 'submitted' row whose tx is provably dead, while the PEL recovery
    // re-claims the SAME command to re-sign it (the re-claim clears the stale signature). A later worker pass
    // expiring the OLD broadcast must NOT flip the freshly re-claimed row to 'failed' — that would fail-alert
    // (pinned!) a command whose NEW attempt is signing right now.
    const s = await seedSubmitted({ signature: 'SIG_STALE' });
    const { conn } = connOf({ statuses: () => null, blockHeight: LVBH + 1_000 }); // old tx: dead
    const w = workerOf(conn);
    await w.loadPending(); // worker watches SIG_STALE
    // Boot recovery re-claims the command (recovering=true) — the stale signature is cleared by the claim:
    expect(await claimExecution(db, s.userId, s.commandId, 'ek', 999, Date.now(), true)).toBe(true);
    expect((await rowOf(s.userId, s.commandId))?.signature).toBeNull();
    await w.tick(); // the worker now tries to expire the OLD broadcast…
    const row = await rowOf(s.userId, s.commandId);
    expect(row?.state).toBe('claimed'); // …and LOSES: the new attempt still owns the row
    expect(events.emit).not.toHaveBeenCalled(); // no spurious pinned failure for a command being re-signed
    expect(w.inflightCount).toBe(0); // the stale watch is dropped either way
  });
});

describe('ConfirmWorker — Inc.4d position ledger (fee base, post-confirm bookkeeping)', () => {
  it('a confirmed CLOSE appends a lamport-exact ledger row from the owner balance delta, BEFORE ev:executed', async () => {
    // WHY: the base = Σin − Σout must be exact; a CLOSE returns SOL (owner delta > 0) → lamports_in. The row is
    // written before the ev:executed publish so the brain's close-confirm fee assessment reads a COMPLETE ledger.
    const s = await seedSubmitted({ signature: 'SIG_CLOSE', publish: publishCtxOf('close') });
    const owner = s.publish?.owner as string;
    const { conn } = connOf({
      statuses: () => ({ confirmationStatus: 'confirmed' }),
      blockHeight: 500,
      transactions: () => txWithOwnerDelta(owner, 100, 1_600_000_100), // +1.6 SOL returned to the owner
    });
    const w = workerOf(conn);
    track(w, s);
    await w.tick();
    const rows = await ledgerRowsOf(s.userId, s.publish?.positionPubkey as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'close', lamportsIn: 1_600_000_000, lamportsOut: 0 });
    expect(bus.publish).toHaveBeenCalledTimes(1); // ev:executed still published (the close reaches the brain)
  });

  it('a confirmed OPEN records lamports_out (SOL deposited); a re-tick never double-counts', async () => {
    const s = await seedSubmitted({ signature: 'SIG_OPEN', publish: publishCtxOf('open') });
    const owner = s.publish?.owner as string;
    const { conn } = connOf({
      statuses: () => ({ confirmationStatus: 'confirmed' }),
      blockHeight: 500,
      transactions: () => txWithOwnerDelta(owner, 1_000_000_050, 50), // −1 SOL deposited (+ ~fee)
    });
    const w = workerOf(conn);
    track(w, s);
    await w.tick();
    // Re-track + re-tick (a redelivery) must not append a second row — the ledger is idempotent on (user, sig, pos).
    track(w, s);
    await w.tick();
    const rows = await ledgerRowsOf(s.userId, s.publish?.positionPubkey as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'open', lamportsIn: 0, lamportsOut: 1_000_000_000 });
  });

  it('a SELL (wallet op) writes NO ledger row (only position legs contribute to the fee base)', async () => {
    const s = await seedSubmitted({ signature: 'SIG_SELL', publish: publishCtxOf('sell') });
    const owner = s.publish?.owner as string;
    const { conn, getTx } = connOf({
      statuses: () => ({ confirmationStatus: 'confirmed' }),
      blockHeight: 500,
      transactions: () => txWithOwnerDelta(owner, 1, 2),
    });
    const w = workerOf(conn);
    track(w, s);
    await w.tick();
    expect(getTx).not.toHaveBeenCalled(); // a non-ledger kind never even fetches the tx
    expect(await ledgerRowsOf(s.userId, s.publish?.positionPubkey as string)).toHaveLength(0);
  });

  it('a getTransaction failure NEVER blocks the land: the row stays landed + ev:executed is published', async () => {
    // WHY: fee bookkeeping is off the money path — a tx-meta fetch blip must degrade to "no ledger row for this
    // position", never corrupt the landed/finalize state nor drop the close confirm.
    const s = await seedSubmitted({ signature: 'SIG_TXFAIL', publish: publishCtxOf('close') });
    const { conn } = connOf({
      statuses: () => ({ confirmationStatus: 'confirmed' }),
      blockHeight: 500,
      transactions: () => {
        throw new Error('rpc blip');
      },
    });
    const w = workerOf(conn);
    track(w, s);
    await expect(w.tick()).resolves.toBeUndefined(); // swallowed
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('landed');
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(await ledgerRowsOf(s.userId, s.publish?.positionPubkey as string)).toHaveLength(0);
  });
});
