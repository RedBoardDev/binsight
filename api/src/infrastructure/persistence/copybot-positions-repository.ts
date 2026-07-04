/**
 * Copy-bot · Inc.4e — read-only projections over `copy_positions` for the API zone: the teardown gate's OPEN-mirror
 * count (SPEC §2.4) and the withdraw helper's deployed capital (SPEC §2.2). Both filter on `status='open'` and the
 * tenant `user_id`. Deliberately a thin Privy-free data layer (no engine/brain deps) so the funds/teardown services
 * stay unit-testable and the API never pulls in the bot runtime.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { openDatabase } from './database';
import { copyPositions } from './schema';

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
}
