/**
 * Copy-bot · Inc.3b step 7b — multi-user boot/reload orchestration (INC3B-PLAN §5).
 *
 * ONE pass reconciles the process to the DB configs; the SAME pass serves boot (empty runtime map) and the live
 * reload (control ping + CONFIG_POLL_MS backstop — reloading everyone per edit is O(users) DB reads, fine at this
 * scale):
 *  1. every ACTIVE user without a runtime is SPAWNED (config seed + persisted mirrors → registry + rug sets,
 *     inside `spawn`) — per-user try/catch: one user's broken boot never blocks the others;
 *  2. every EXISTING runtime gets a fresh config; the prev/next diff drives `applyStopCloses` (STOP =
 *     FORCE-CLOSE, SPEC §4.3). A DEACTIVATED (or fail-closed) user's runtime is RETAINED — its own stop-close
 *     diff (user_stopped) force-closes everything and it keeps reconciling until its mirrors and rugExitPending
 *     drain (never-miss) — while `userConfigs` (enabled:false) drops it from the open fan-out targets;
 *  3. the hub is reconciled to `computeLeaderSet(configs)` — the CONFIG-DRIVEN leader set (step 7a): an added
 *     leader is replay-seeded before being watched (forward-only), a removed one drains;
 *  4. freshly-spawned users join the reconcile immediately (`onUsersSpawned`) so a mirror restored for a user
 *     whose leader closed while they were un-booted is force-closed NOW, not a tick later.
 *
 * Runtimes are never DELETED here: a retained runtime is cheap (its maps drain), and deleting one early could
 * strand an in-flight close (the forbidden miss). Deps are injected so the whole orchestration is unit-testable.
 */
import type { Logger } from 'pino';
import type { CopybotConfig } from '@/domain/copybot/config';
import { computeLeaderSet } from '@/domain/copybot/fan-out';

/** The runtime surface the reload drives (structural — `UserRuntime` satisfies it; tests stub it). */
export interface ReloadableRuntime {
  readonly userId: string;
  getConfig(): CopybotConfig;
  setConfig(next: CopybotConfig): void;
  applyStopCloses(prev: CopybotConfig, next: CopybotConfig): Promise<void>;
}

export interface ReloadDeps<R extends ReloadableRuntime> {
  log: Logger;
  listActiveUserIds(): Promise<string[]>;
  /** ConfigStore.load — fail-safe AND fail-closed (a corrupt row parses to a stopped config, never throws). */
  loadConfig(userId: string): Promise<CopybotConfig>;
  /** createUserRuntime + durable seeding (persisted mirrors → registry + opens-window ring; rug sets inside).
   *  Must NOT register itself — this orchestrator owns the maps (a throwing spawn must leave no half-entry). */
  spawn(userId: string, config: CopybotConfig): Promise<R>;
  /** THE live maps the fan-out/status/sweeps read (owned by brain-main, mutated in place here). */
  runtimes: Map<string, R>;
  userConfigs: Map<string, CopybotConfig>;
  /** hub.applyLeaderSet — replay-seeds added leaders (forward-only), drains removed ones. */
  applyLeaderSet(next: Set<string>): Promise<void>;
  /** ≥1 NEW runtime spawned this pass → run one immediate reconcile pass (per-user boot failsafe). */
  onUsersSpawned(): Promise<void>;
}

/** One boot/reload pass — see the module doc. Never throws: every phase is isolated so a failing user/DB/hub
 *  call degrades to "retried on the next reload", never a crashed reload loop. */
export async function reloadAllUsers<R extends ReloadableRuntime>(
  deps: ReloadDeps<R>,
): Promise<void> {
  // 1. Spawn NEW active users.
  let activeIds: string[];
  try {
    activeIds = await deps.listActiveUserIds();
  } catch (e) {
    // Without the active list we can't spawn, but the EXISTING runtimes must still refresh (a kill-switch edit
    // must land even when the listing query hiccups).
    deps.log.error(
      { e: (e as Error).message },
      'reload: listActiveUserIds failed → no new users this pass',
    );
    activeIds = [];
  }
  const spawnedNow = new Set<string>();
  for (const userId of activeIds) {
    if (deps.runtimes.has(userId)) continue;
    try {
      const config = await deps.loadConfig(userId);
      const rt = await deps.spawn(userId, config);
      deps.runtimes.set(userId, rt);
      deps.userConfigs.set(userId, config);
      spawnedNow.add(userId);
      deps.log.info({ userId }, '👤 user runtime spawned');
    } catch (e) {
      deps.log.error(
        { e: (e as Error).message, userId },
        'reload: user spawn failed → skipped this pass (retried next reload)',
      );
    }
  }

  // 2. Refresh EVERY existing runtime (including deactivated ones — retention, see module doc). STOP =
  // FORCE-CLOSE (SPEC §4.3): diff the config we were RUNNING (prev, the last loaded value in memory — never a
  // stale/boot snapshot, so a restart can't replay an old stop) against the fresh load.
  for (const rt of deps.runtimes.values()) {
    if (spawnedNow.has(rt.userId)) continue; // just loaded+spawned — nothing to diff yet
    try {
      const prev = rt.getConfig();
      const next = await deps.loadConfig(rt.userId);
      rt.setConfig(next);
      deps.userConfigs.set(rt.userId, next); // the fan-out targets from this live view
      await rt.applyStopCloses(prev, next);
    } catch (e) {
      deps.log.error(
        { e: (e as Error).message, userId: rt.userId },
        'reload: user config refresh failed → previous config stands (retried next reload)',
      );
    }
  }

  // 3. Config-driven leader set (step 7a).
  try {
    await deps.applyLeaderSet(computeLeaderSet(deps.userConfigs));
  } catch (e) {
    // A failed add (replay-seed error) discards its half-built entry inside the hub; retried next reload.
    deps.log.error(
      { e: (e as Error).message },
      'reload: leader-set apply failed → retried on the next reload',
    );
  }

  // 4. New users join the reconcile immediately.
  if (spawnedNow.size > 0) {
    await deps
      .onUsersSpawned()
      .catch((e) =>
        deps.log.error(
          { e: (e as Error).message },
          'reload: post-spawn reconcile failed (periodic reconcile covers it)',
        ),
      );
  }
}
