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
import * as schema from '@/infrastructure/persistence/schema';
import { executions } from '@/infrastructure/persistence/schema';
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
  lastValidBlockHeight?: number | null; // undefined ⇒ the default LVBH; null models a legacy pre-#7 row
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
    lastValidBlockHeight:
      opts.lastValidBlockHeight === undefined ? LVBH : opts.lastValidBlockHeight,
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
/** The optional second arg of getSignatureStatus(es); its `searchTransactionHistory` selects the history mock. */
type StatusConfig = { searchTransactionHistory?: boolean };
/** A conn whose batch status read + block height are scripted; `getSignatureStatus` serves the recovery path.
 *  `historyStatuses` is served instead of `statuses` when a caller passes `searchTransactionHistory: true` — this
 *  lets a test model a tx that is invisible to the recent-status cache but present in full history (#148).
 *  `onBlockHeight` fires inside `getBlockHeight` (called once at the START of a tick, before the status batch): the
 *  deterministic seam a test uses to inject a concurrent re-track at that await boundary (#149). */
function connOf(opts: {
  statuses: (sig: string) => Status;
  historyStatuses?: (sig: string) => Status;
  blockHeight: number;
  onBlockHeight?: () => void | Promise<void>;
}): {
  conn: Connection;
  getStatuses: ReturnType<typeof vi.fn>;
} {
  const statusOf = (sig: string, config?: StatusConfig): Status => {
    if (config?.searchTransactionHistory) return (opts.historyStatuses ?? opts.statuses)(sig);
    return opts.statuses(sig);
  };
  const getStatuses = vi.fn(async (sigs: string[], config?: StatusConfig) => ({
    value: sigs.map((s) => statusOf(s, config)),
  }));
  const conn = {
    getSignatureStatuses: getStatuses,
    getSignatureStatus: async (s: string, config?: StatusConfig) => ({
      value: statusOf(s, config),
    }),
    getBlockHeight: async () => {
      await opts.onBlockHeight?.();
      return opts.blockHeight;
    },
  } as unknown as Connection;
  return { conn, getStatuses };
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
    hmacKey: 'k',
    log,
  });

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

  it('★ a LEGACY row with an UNKNOWN (null→0) lastValidBlockHeight is NEVER failed on height alone — keeps polling', async () => {
    // WHY (no-miss): lastValidBlockHeight is persisted only since #7. A pre-#7 'submitted' row re-read at boot has
    // NULL, which loadPending coerces to 0. `height > 0` is trivially true, so the naive expiry path would MIS-FAIL
    // such a broadcast the moment it is not-found — declaring dead (and re-driving a close) a tx whose REAL expiry is
    // unknown. A row with an unknown expiry must keep polling until a real on-chain status resolves it. Contrast the
    // EXPIRY test above: a row with a genuine lvbh still fails, so the death path is not weakened.
    const s = await seedSubmitted({ signature: 'SIG_UNKNOWN_LVBH' });
    const { conn, getStatuses } = connOf({ statuses: () => null, blockHeight: LVBH + 1_000_000 });
    const w = workerOf(conn);
    w.track({
      userId: s.userId,
      commandId: s.commandId,
      signature: s.signature,
      lastValidBlockHeight: 0, // the sentinel loadPending assigns a legacy NULL lastValidBlockHeight
      publish: s.publish,
    });
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('submitted'); // NOT 'failed' — unknown ≠ expired
    expect(w.inflightCount).toBe(1); // still watched — a later REAL status (not height) will resolve it
    expect(getStatuses).toHaveBeenCalledTimes(1); // only the cheap batch — no history-search death re-check ran
    expect(bus.publish).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled(); // no spurious pinned "close manually" alert
  });

  it('loadPending resumes a legacy NULL-lvbh row and a not-found tick leaves it submitted (end-to-end)', async () => {
    // WHY: the full durable-recovery path — a pre-#7 row is stored with a NULL lastValidBlockHeight; loadPending must
    // resume it (coerce → unknown sentinel, no crash) and a subsequent not-found tick must leave it 'submitted', never
    // fail it purely because the chain height exceeds a fabricated 0. blockHeight is kept below the OTHER seeded rows'
    // real lvbh so this shared-db test only ever resolves its own row.
    const s = await seedSubmitted({ signature: 'SIG_LEGACY_NULL', lastValidBlockHeight: null });
    const { conn } = connOf({ statuses: () => null, blockHeight: 500 });
    const w = workerOf(conn);
    expect(await w.loadPending()).toBeGreaterThanOrEqual(1); // the legacy NULL row is resumed (coerced)
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('submitted'); // its NULL→0 lvbh spared it the death path
  });

  it('#148 — an aged LANDED tx invisible to the recent-cache batch is confirmed via HISTORY search, not failed', async () => {
    // WHY: after a downtime the batched getSignatureStatuses reads only the recent-status cache (no
    // searchTransactionHistory), so a tx that LANDED before the gap returns null; its blockhash is now expired, so
    // the naive death path would finalize 'failed' and fire the pinned "close manually" alert for a position that
    // is in fact OPEN. The death branch must re-check the signature against full history before declaring it dead.
    const s = await seedSubmitted({ signature: 'SIG_AGED_LANDED' });
    const { conn, getStatuses } = connOf({
      statuses: () => null, // recent-status cache: invisible
      historyStatuses: () => ({ confirmationStatus: 'finalized' }), // full history: it actually landed
      blockHeight: LVBH + 1, // blockhash expired → the naive path would call it dead
    });
    const w = workerOf(conn);
    track(w, s);
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('landed'); // NOT 'failed'
    expect(bus.publish).toHaveBeenCalledTimes(1); // the landed close still reaches the brain
    const codes = vi.mocked(events.emit).mock.calls.map((c) => c[0]);
    expect(codes).toContain('sign.landed');
    expect(codes).not.toContain('sign.land_failed'); // no spurious failure
    expect(codes).not.toContain('lifecycle.close_failed'); // no spurious pinned "close manually" alert
    // The re-check is a targeted single-signature read WITH searchTransactionHistory, only on the death branch:
    expect(getStatuses).toHaveBeenCalledTimes(2);
    expect(getStatuses.mock.calls[0]?.[1]).toBeUndefined(); // the cheap batch pass: no history search
    expect(getStatuses.mock.calls[1]?.[0]).toEqual(['SIG_AGED_LANDED']);
    expect(getStatuses.mock.calls[1]?.[1]).toEqual({ searchTransactionHistory: true });
    expect(w.inflightCount).toBe(0);
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

  it('#149 — a stale resolve of the OLD signature never evicts a concurrently re-tracked NEW attempt', async () => {
    // WHY: tick() snapshots the inflight set, then awaits the RPC. If a recovery re-sign re-tracks the SAME command
    // with a NEW signature at that await boundary, resolving the OLD signature must (a) LOSE the signature-pinned
    // CAS and (b) NOT delete the map entry now holding the NEW attempt — otherwise the new tx lands but nothing
    // finalizes/publishes it and the row wedges in 'submitted' until restart. The old delete-by-key-before-the-CAS
    // evicted the NEW entry; the fix untracks only when the map still holds THIS exact signature.
    const s = await seedSubmitted({ signature: 'SIG_OLD' });
    const SIG_NEW = 'SIG_NEW';
    let reTracked = false;
    let worker: ConfirmWorker | undefined;
    const { conn } = connOf({
      statuses: (sig) => (sig === SIG_NEW ? { confirmationStatus: 'confirmed' } : null),
      blockHeight: LVBH + 1, // OLD blockhash expired → the stale path would try to fail it
      onBlockHeight: async () => {
        // Fires after tick's snapshot, before the status batch: the recovery lane re-signs (the row now points to
        // the NEW signature) and the worker re-tracks it (same key replaces SIG_OLD in the inflight map).
        if (reTracked) return;
        reTracked = true;
        await db
          .update(executions)
          .set({ signature: SIG_NEW })
          .where(and(eq(executions.userId, s.userId), eq(executions.commandId, s.commandId)));
        worker?.track({
          userId: s.userId,
          commandId: s.commandId,
          signature: SIG_NEW,
          lastValidBlockHeight: LVBH,
          publish: s.publish,
        });
      },
    });
    const w = workerOf(conn);
    worker = w;
    track(w, s); // the worker starts watching SIG_OLD
    await w.tick(); // snapshot=[SIG_OLD]; re-track injects SIG_NEW; SIG_OLD resolves stale and LOSES the CAS
    expect(w.inflightCount).toBe(1); // the NEW attempt is still watched (NOT evicted by the stale resolve)
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('submitted'); // SIG_NEW pending, never failed
    expect(bus.publish).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled(); // no spurious pinned failure for the OLD sig
    // …and because it stayed watched, the next tick confirms + publishes the NEW attempt:
    await w.tick();
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('landed');
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect((vi.mocked(bus.publish).mock.calls[0]?.[3] as { sig?: string }).sig).toBe(SIG_NEW);
  });

  it('#148 — recovery pre-check confirms an aged LANDED tx via history search (never re-signs a landed move)', async () => {
    // WHY: at boot a tx that LANDED before the downtime is gone from the recent-status cache; without
    // searchTransactionHistory classifyPriorTx reads it as not-found → 'dead' → recoveryPreCheck would re-claim and
    // RE-SIGN a money move that already executed. The pre-check must search full history and finalize 'landed'.
    const s = await seedSubmitted({ signature: 'SIG_AGED_RECOVER' });
    const { conn } = connOf({
      statuses: () => null, // recent cache: invisible
      historyStatuses: () => ({ confirmationStatus: 'finalized' }), // full history: landed
      blockHeight: LVBH + 1, // blockhash expired → the naive path would call it 'dead' (→ re-sign)
    });
    const { ctx, sr } = recoveryFixture(s, conn);
    const verdict = await recoveryPreCheck(ctx, sr);
    expect(verdict).toEqual({ ok: true, kind: 'close' }); // acknowledged as terminal — NOT re-signed
    expect((await rowOf(s.userId, s.commandId))?.state).toBe('landed');
    expect(bus.publish).toHaveBeenCalledTimes(1); // the landed close is published once
  });
});
