/**
 * Copy-bot · brain — persistence of copied positions (`copy_positions`). SOURCE OF TRUTH that survives
 * restarts: at boot, the brain reloads the open mirrors → the failsafe can close those whose leader closed
 * during the downtime (anti DORMANT position). Write-through at open/close.
 * Bound to ONE user at construction (SPEC §11): every row carries the tenant, and every query is scoped to it —
 * two users mirroring the SAME leader position are two independent rows (PK (user_id, leader_position)).
 */
import { and, eq } from 'drizzle-orm';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { copyPositions } from '@/infrastructure/persistence/schema';
import type { Mirror } from './mirror-registry';

type Db = ReturnType<typeof openDatabase>;

export class MirrorStore {
  constructor(
    private readonly db: Db,
    /** Tenant this store is bound to — one runtime = one user; rows never cross tenants. */
    private readonly userId: string,
  ) {}

  async saveOpen(m: Mirror): Promise<void> {
    // Upsert (NOT insert-or-ignore): re-opening the SAME (userId, leaderPosition) after a prior force-close
    // (our row was left at status='closed' while the leader's position stayed open on-chain) must REWRITE the row
    // back to 'open'. With onConflictDoNothing the fresh, funded on-chain copy would stay hidden under the stale
    // 'closed' row and loadOpen would skip it at boot → an UNTRACKED money position (finding #45/#63). Idempotent
    // and safe: mirror-registry admits at most ONE live mirror per (userId, leaderPosition), so a re-save of the
    // same open just rewrites identical values. The PK columns are the conflict target and never change, so `set`
    // updates every NON-PK column, mirroring exactly what `.values()` writes (leave no field stale).
    await this.db
      .insert(copyPositions)
      .values({
        userId: this.userId,
        leaderPosition: m.leaderPosition,
        leader: m.leaderAddress,
        ourPosition: m.ourPosition,
        pool: m.pool,
        nonSolSymbol: m.nonSolSymbol,
        nonSolMint: m.nonSolMint,
        sizeSol: m.sizeSol,
        lowerBin: m.lowerBin,
        upperBin: m.upperBin,
        status: 'open',
        openedAt: m.openedAt,
        closedAt: null,
      })
      .onConflictDoUpdate({
        target: [copyPositions.userId, copyPositions.leaderPosition],
        set: {
          leader: m.leaderAddress,
          ourPosition: m.ourPosition,
          pool: m.pool,
          nonSolSymbol: m.nonSolSymbol,
          nonSolMint: m.nonSolMint,
          sizeSol: m.sizeSol,
          lowerBin: m.lowerBin,
          upperBin: m.upperBin,
          status: 'open',
          openedAt: m.openedAt,
          closedAt: null,
        },
      });
  }

  /** Persist the new SOL size after a proportional add/remove (so the effective ratio survives a restart). */
  async updateSize(leaderPosition: string, sizeSol: number): Promise<void> {
    await this.db
      .update(copyPositions)
      .set({ sizeSol })
      .where(this.byLeaderPosition(leaderPosition));
  }

  async markClosed(leaderPosition: string): Promise<void> {
    await this.db
      .update(copyPositions)
      .set({ status: 'closed', closedAt: Date.now() })
      .where(this.byLeaderPosition(leaderPosition));
  }

  /** Still-open mirrors of THIS user — reloaded at boot to never lose a position (no-dormant). */
  async loadOpen(): Promise<Mirror[]> {
    const rows = await this.db
      .select()
      .from(copyPositions)
      .where(and(eq(copyPositions.userId, this.userId), eq(copyPositions.status, 'open')));
    return rows.map((r) => ({
      leaderPosition: r.leaderPosition,
      // Legacy pre-3b row (leader NULL) → '': planStopCloses.isStarted('') is false (no leader has an empty
      // address), so per-leader stop transitions never touch it — only a GLOBAL stop force-closes it. That is the
      // safe default for a row whose leader we cannot know (fresh-start DB per SPEC §15 makes this transient).
      leaderAddress: r.leader ?? '',
      ourPosition: r.ourPosition,
      pool: r.pool,
      nonSolSymbol: r.nonSolSymbol,
      // Legacy row (non_sol_mint NULL) → '': matches no real candidate mint, so it is never counted toward the
      // per-token concurrency cap (safe default; a fresh-start DB has no such rows per SPEC §15).
      nonSolMint: r.nonSolMint ?? '',
      sizeSol: r.sizeSol,
      lowerBin: r.lowerBin,
      upperBin: r.upperBin,
      openedAt: r.openedAt,
      status: 'open' as const,
    }));
  }

  /** Tenant-scoped row filter: user #2's mirror of the same leader position is a DIFFERENT row. */
  private byLeaderPosition(leaderPosition: string) {
    return and(
      eq(copyPositions.userId, this.userId),
      eq(copyPositions.leaderPosition, leaderPosition),
    );
  }
}
