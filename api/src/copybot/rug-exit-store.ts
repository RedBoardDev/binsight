/**
 * Copy-bot · brain — DURABLE rug-exit state, ROW-LEVEL (SPEC §12; replaces the settings-KV JSON blobs, which
 * failed OPEN: a corrupt blob silently loaded as an EMPTY set, dropping the re-open suppression AND the pending
 * re-close retries in one shot). Two per-user sets, ONE ROW PER MEMBER — inserts/deletes are atomic and
 * corruption-proof (a single bad row can no longer wipe the whole set):
 *  · `rug_exits`         — LEADER positions we rug-SL-exited → suppress RE-OPEN across restarts. Rug-SL is our
 *    INDEPENDENT crash-exit: it closes our mirror while the leader's position stays open on-chain, so without
 *    this set a fresh process would re-enter the rug on the leader's next add. Bounded by the number of distinct
 *    rug exits (a NEW leader open uses a new pubkey, never matched).
 *  · `rug_exit_pending`  — OUR positions rug-SL/stop-closed but NOT yet confirmed gone → RE-CLOSE across
 *    restarts (never-miss-close). A row is DELETED once the close is confirmed (ev:executed close-confirm or the
 *    reconcile purge).
 * Bound to ONE user at construction (the boot binds SYSTEM_USER_ID today; the multi-user fan-out constructs one
 * store per runtime). Mid-run WRITES stay FAIL-SAFE (logged, never thrown): the in-memory set still drives the
 * current process; only cross-restart durability is at risk on a write error. Boot-SEED reads (`load`/`loadPending`,
 * called once per runtime at spawn) instead FAIL LOUD — they retry a transient DB error with bounded backoff and,
 * on a PERSISTENT error, THROW so the caller REFUSES to spawn that runtime. A silently-empty set would drop the
 * re-open suppression AND the pending re-close in one shot (finding #152): the runtime would seed a rug-exit-pending
 * position as a NORMAL open mirror, so no sweep ever re-closes it and it bleeds in the rugged pool. A deferred spawn
 * is retried on the next reload (a normal user); SYSTEM, booted once outside the reload loop, fails the brain loud.
 */
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { rugExitPendings, rugExits } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Boot-seed reads (load/loadPending) FAIL LOUD, never silently empty: a briefly-saturated Postgres on restart must
// not seed an empty set (finding #152 — a dropped rug-exit-PENDING entry means a rugging position is never
// re-closed). Bounded so a genuinely-down DB still surfaces (the reload loop skips + retries the spawn; SYSTEM
// fails the brain loud) instead of hanging boot. Mirrors the coffre signer's bounded backoff (coffre/signer.ts).
const RUG_EXIT_SEED_READ_RETRIES = 3; // retries AFTER the initial attempt before refusing to spawn (never seed empty)
const RUG_EXIT_SEED_READ_BASE_DELAY_MS = 250; // exponential backoff base (250→500→1000ms): sub-second, no healthy-boot stall

export class RugExitStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    /** Tenant this store is bound to (SPEC §11) — one runtime = one user; rows never cross tenants. */
    private readonly userId: string,
  ) {}

  /** Run a boot-SEED read with bounded exponential backoff, then FAIL LOUD (rethrow). A transient DB error (a
   *  saturated Postgres on restart) is retried; a PERSISTENT one throws so `createUserRuntime` refuses to spawn this
   *  runtime — the reload loop skips + retries it next pass (a normal user), or the brain fails loud (SYSTEM, booted
   *  once). NEVER returns a silently-empty set: an empty set would drop the re-open suppression / pending re-close
   *  and let a rugging position bleed un-re-closed (finding #152). */
  private async seedRead<T>(read: () => PromiseLike<T>, table: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RUG_EXIT_SEED_READ_RETRIES; attempt++) {
      try {
        return await read();
      } catch (e) {
        lastError = e;
        if (attempt < RUG_EXIT_SEED_READ_RETRIES) {
          this.log.warn(
            { e: (e as Error).message, table, attempt },
            'rug-exit seed read failed → bounded retry',
          );
          await sleep(RUG_EXIT_SEED_READ_BASE_DELAY_MS * 2 ** attempt);
        }
      }
    }
    this.log.error(
      { e: (lastError as Error)?.message, table, attempts: RUG_EXIT_SEED_READ_RETRIES + 1 },
      'rug-exit seed read failed after retries → refusing to seed (runtime spawn deferred, never seeded empty)',
    );
    throw lastError instanceof Error
      ? lastError
      : new Error(`rug-exit seed read failed for ${table}`);
  }

  /** Seed this user's rug-exited LEADER positions (re-open suppression) at boot. FAILS LOUD after bounded retries
   *  (never a silent empty set → never a re-entered rug); the caller then refuses to spawn (deferred to the next
   *  reload). Seeded once per runtime so a leader add can't re-enter a rug-exited position across a restart. */
  async load(): Promise<Set<string>> {
    const rows = await this.seedRead(
      () =>
        this.db
          .select({ leaderPosition: rugExits.leaderPosition })
          .from(rugExits)
          .where(eq(rugExits.userId, this.userId)),
      'rug_exits',
    );
    return new Set(rows.map((r) => r.leaderPosition));
  }

  /** Seed this user's rug-exit-PENDING OUR positions (rug-SL/stop-closed, awaiting on-chain confirmation → re-close)
   *  at boot. FAILS LOUD after bounded retries (finding #152: a silent empty set would seed a rug-exit-pending
   *  position as a NORMAL open mirror — no sweep re-closes it and it bleeds); the caller then refuses to spawn.
   *  Seeded once per runtime so a failed rug-SL close keeps being re-closed across a restart until confirmed gone. */
  async loadPending(): Promise<Set<string>> {
    const rows = await this.seedRead(
      () =>
        this.db
          .select({ ourPosition: rugExitPendings.ourPosition })
          .from(rugExitPendings)
          .where(eq(rugExitPendings.userId, this.userId)),
      'rug_exit_pending',
    );
    return new Set(rows.map((r) => r.ourPosition));
  }

  /** Persist ONE rug-exited leader position (atomic row insert; idempotent on re-add). Fail-safe: a write error
   *  is logged, never thrown (the in-memory set still suppresses re-open this run). */
  async addExited(leaderPosition: string): Promise<void> {
    try {
      await this.db
        .insert(rugExits)
        .values({ userId: this.userId, leaderPosition, exitedAt: Date.now() })
        .onConflictDoNothing();
    } catch (e) {
      this.log.warn(
        { e: (e as Error).message, leaderPosition },
        'rug-exit row save failed (in-memory still suppresses re-open this run)',
      );
    }
  }

  /** Persist ONE pending re-close (atomic row insert; idempotent on re-add). Fail-safe: a write error is logged,
   *  never thrown (the in-memory set still drives the re-close this run). */
  async addPending(ourPosition: string): Promise<void> {
    try {
      await this.db
        .insert(rugExitPendings)
        .values({ userId: this.userId, ourPosition, createdAt: Date.now() })
        .onConflictDoNothing();
    } catch (e) {
      this.log.warn(
        { e: (e as Error).message, ourPosition },
        'rug-exit-pending row save failed (in-memory still re-closes this run)',
      );
    }
  }

  /** Delete ONE pending re-close (the close was CONFIRMED gone on-chain). No-op if absent. Fail-safe: a write
   *  error is logged, never thrown (the stale row is re-purged on the next confirm/reconcile pass). */
  async removePending(ourPosition: string): Promise<void> {
    try {
      await this.db
        .delete(rugExitPendings)
        .where(
          and(
            eq(rugExitPendings.userId, this.userId),
            eq(rugExitPendings.ourPosition, ourPosition),
          ),
        );
    } catch (e) {
      this.log.warn(
        { e: (e as Error).message, ourPosition },
        'rug-exit-pending row delete failed (re-purged on the next confirm)',
      );
    }
  }
}

/**
 * Purge ONE position from the pending re-close set on a CONFIRMED close — shared by the brain's ev:executed
 * close-confirm handler AND the reconcile's markClosed pass. Without the ev:executed call, only the reconcile
 * purged the entry, leaving it inert (a stale forever-row once the mirror is unregistered). The durable delete is
 * attempted UNCONDITIONALLY (idempotent), even on an in-memory miss: `removePending` is fail-safe, so a swallowed
 * transient error on an earlier purge can clear memory yet leave the row — short-circuiting on the memory miss
 * would then ORPHAN that row forever (re-seeded at every boot, re-closing an already-gone position). Memory +
 * durable must never diverge. Returns whether the in-memory set held the entry.
 */
export async function purgeRugExitPending(
  pending: Set<string>,
  store: Pick<RugExitStore, 'removePending'>, // structural: the multi-user sweep passes stub-able runtime surfaces
  ourPosition: string,
): Promise<boolean> {
  const wasPending = pending.delete(ourPosition);
  // Always delete the durable row — NOT gated on `wasPending`. A prior purge may have cleared memory while its
  // fail-safe `removePending` swallowed a transient DB error, leaving the row; this unconditional (idempotent)
  // delete is what finally reclaims it. A delete of an absent row is a harmless no-op.
  await store.removePending(ourPosition);
  return wasPending;
}
