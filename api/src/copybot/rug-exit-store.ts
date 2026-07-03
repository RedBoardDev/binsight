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
 * store per runtime). Writes stay FAIL-SAFE (logged, never thrown): the in-memory set still drives the current
 * process; only cross-restart durability is at risk on a write error. Reads never throw either (empty + loud log
 * on a DB error — the brain must still boot).
 */
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { rugExitPendings, rugExits } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

export class RugExitStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    /** Tenant this store is bound to (SPEC §11) — one runtime = one user; rows never cross tenants. */
    private readonly userId: string,
  ) {}

  /** Load this user's rug-exited LEADER positions (re-open suppression). Empty (and logged) on a read error. */
  async load(): Promise<Set<string>> {
    try {
      const rows = await this.db
        .select({ leaderPosition: rugExits.leaderPosition })
        .from(rugExits)
        .where(eq(rugExits.userId, this.userId));
      return new Set(rows.map((r) => r.leaderPosition));
    } catch (e) {
      this.log.warn({ e: (e as Error).message }, 'rug-exit set load failed → starting empty');
      return new Set();
    }
  }

  /** Load this user's rug-exit-PENDING OUR positions (rug-SL/stop-closed, awaiting on-chain confirmation →
   *  re-close). Empty (and logged) on a read error — never throws. Seeded at boot so a failed rug-SL close is
   *  retried across a brain restart (never-miss-close pillar) until the close is confirmed. */
  async loadPending(): Promise<Set<string>> {
    try {
      const rows = await this.db
        .select({ ourPosition: rugExitPendings.ourPosition })
        .from(rugExitPendings)
        .where(eq(rugExitPendings.userId, this.userId));
      return new Set(rows.map((r) => r.ourPosition));
    } catch (e) {
      this.log.warn(
        { e: (e as Error).message },
        'rug-exit-pending set load failed → starting empty',
      );
      return new Set();
    }
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
 * purged the entry, leaving it inert (a stale forever-row once the mirror is unregistered). Returns whether an
 * entry was actually purged (memory + durable row together — the two must never diverge across a restart).
 */
export async function purgeRugExitPending(
  pending: Set<string>,
  store: Pick<RugExitStore, 'removePending'>, // structural: the multi-user sweep passes stub-able runtime surfaces
  ourPosition: string,
): Promise<boolean> {
  if (!pending.delete(ourPosition)) return false;
  await store.removePending(ourPosition);
  return true;
}
