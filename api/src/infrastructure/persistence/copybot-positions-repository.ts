/**
 * Copy-bot · Inc.4e — read-only projections over `copy_positions` for the API zone: the teardown gate's OPEN-mirror
 * count (SPEC §2.4) and the withdraw helper's deployed capital (SPEC §2.2). Both filter on `status='open'` and the
 * tenant `user_id`. Deliberately a thin Privy-free data layer (no engine/brain deps) so the funds/teardown services
 * stay unit-testable and the API never pulls in the bot runtime.
 */
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { openDatabase } from './database';
import { copyPositions, feeLedger } from './schema';

type Db = ReturnType<typeof openDatabase>;

export class CopybotPositionsRepository {
  constructor(private readonly db: Db) {}

  /** How many mirrors are currently OPEN for the user — the teardown gate AND the post-force-close confirm check. */
  async openMirrorCount(userId: string): Promise<number> {
    const [r] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(copyPositions)
      .where(and(eq(copyPositions.userId, userId), eq(copyPositions.status, 'open')));
    return Number(r?.c ?? 0);
  }

  /** SOL committed to the user's OPEN mirrors (Σ size_sol) — the withdraw helper's `deployed`. */
  async deployedSol(userId: string): Promise<number> {
    const [r] = await this.db
      .select({ s: sql<number>`coalesce(sum(${copyPositions.sizeSol}), 0)` })
      .from(copyPositions)
      .where(and(eq(copyPositions.userId, userId), eq(copyPositions.status, 'open')));
    return Number(r?.s ?? 0);
  }

  /** DISTINCT `user_id` of every mirror still OPEN, across ALL tenants — the brain's boot/reload spawn UNION. A
   *  user STOPPED (or whose disabling was written) while the brain was DOWN is `enabled:false`, so the config
   *  store's active-user list omits them; but their positions sit on-chain. (Re)spawning them from this set is
   *  what lets reconcile + stop-close + sweeps drain and force-close the stranded mirrors — the forbidden missed
   *  close (finding #134). Deliberately cross-tenant: this is the ONE brain-wide open-mirror scan. */
  async listUserIdsWithOpenMirrors(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: copyPositions.userId })
      .from(copyPositions)
      .where(eq(copyPositions.status, 'open'));
    return rows.map((r) => r.userId);
  }

  /**
   * #140 no-miss backstop — CLOSED mirrors (owned by a BOOTED runtime) that STILL have NO `fee_ledger` row, closed
   * longer ago than `closedBeforeMs` (a grace so a normal close-sell's exact assess wins first — a fee that lands a
   * few minutes late is fine; racing the sell would assess prematurely, missing its proceeds row). An anti-join
   * (LEFT JOIN fee_ledger → NULL). This is the safety net for the DEFERRED-sell tail: a sell that failed/never
   * confirmed (so onSellConfirmed never assessed) still gets its fee assessed here, on the ledger as it stands.
   * Idempotent with the sell-confirm path via `feeLedger.assess`'s (userId, ourPosition) key. Bounded by `limit`.
   */
  async listClosedWithoutFee(
    bootedUserIds: string[],
    limit: number,
    closedBeforeMs: number,
  ): Promise<Array<{ userId: string; ourPosition: string }>> {
    if (bootedUserIds.length === 0) return []; // no runtime booted → nothing actionable this pass
    return this.db
      .select({ userId: copyPositions.userId, ourPosition: copyPositions.ourPosition })
      .from(copyPositions)
      .leftJoin(
        feeLedger,
        and(
          eq(feeLedger.userId, copyPositions.userId),
          eq(feeLedger.ourPosition, copyPositions.ourPosition),
        ),
      )
      .where(
        and(
          eq(copyPositions.status, 'closed'),
          inArray(copyPositions.userId, bootedUserIds),
          // markClosed always stamps closedAt; a null (legacy/anomalous) closed row is definitely "settled long
          // ago" → include it (never miss a fee) rather than let the grace comparison silently drop it.
          or(isNull(copyPositions.closedAt), lt(copyPositions.closedAt, closedBeforeMs)),
          isNull(feeLedger.id),
        ),
      )
      .orderBy(asc(copyPositions.closedAt))
      .limit(limit);
  }
}
