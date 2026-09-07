/**
 * Copy-bot · Inc.3b step 7b — multi-user boot/reload orchestration (INC3B-PLAN §5).
 *
 * ONE pass reconciles the process to the DB configs; the SAME pass serves boot (empty runtime map) and the live
 * reload (control ping + CONFIG_POLL_MS backstop — reloading everyone per edit is O(users) DB reads, fine at this
 * scale):
 *  1. the boot/reload spawn set is the UNION of ACTIVE users, users still holding an OPEN mirror row, AND users still
 *     owing a PENDING performance fee: a user STOPPED while the brain was DOWN (enabled:false ⇒ absent from
 *     listActiveUserIds) is still spawned so their stranded positions can drain (finding #134) and any pending fee is
 *     collected (finding #3 — fee-sweep-only). Each is SPAWNED (config seed + persisted mirrors → registry +
 *     rug sets, inside `spawn`) — per-user try/catch: one user's broken boot never blocks the others; then any
 *     seeded mirror the boot config no longer starts is force-closed on the spot (finding #135), because the
 *     phase-2 diff can't see a stop written during downtime (a fresh spawn has no prev≠next transition);
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
  /** Boot-seed force-close: after this runtime is (re)spawned with its persisted open mirrors, force-close any
   *  whose leader is disabled/absent in `boot` — a STOP written while the brain was down (finding #135). Replay-safe
   *  by the "open mirror ⇒ started leader" invariant; the runtime's RECLOSE_GRACE_MS gate dedupes an in-flight close. */
  applyBootStopCloses(boot: CopybotConfig): Promise<void>;
}

export interface ReloadDeps<R extends ReloadableRuntime> {
  log: Logger;
  listActiveUserIds(): Promise<string[]>;
  /** copy_positions projection: DISTINCT user_id WHERE status='open'. The boot/reload spawn set is
   *  activeUsers ∪ theseUsers, so a user STOPPED (or disabled) while the brain was DOWN still gets a runtime —
   *  drained (disabled config ⇒ out of the open fan-out) but reconciling + stop-closing + sweeping until their
   *  stranded mirrors force-close (the forbidden missed close, finding #134). */
  listUserIdsWithOpenMirrors(): Promise<string[]>;
  /** fee_ledger projection: DISTINCT user_id WHERE state='pending'. Unioned into the boot/reload spawn set
   *  (finding #3) so a user STOPPED with a pending performance fee — no open mirror ⇒ absent from BOTH
   *  listActiveUserIds and listUserIdsWithOpenMirrors — is still spawned (drained / fee-sweep-only), so the
   *  operator collects that fee. Makes bootable the users listPending's booted-only filter (#155) would otherwise
   *  strand forever: #155 stops un-bootable fees from head-of-line-blocking the batch; this makes them bootable. */
  listUserIdsWithPendingFees(): Promise<string[]>;
  /** ConfigStore.load — fail-safe AND fail-closed (a corrupt row parses to a stopped config, never throws). */
  loadConfig(userId: string): Promise<CopybotConfig>;
  /** createUserRuntime + durable seeding (persisted mirrors → registry + opens-window ring; rug sets inside).
   *  Must NOT register itself — this orchestrator owns the maps (a throwing spawn must leave no half-entry).
   *  Returns null when the user is not spawnable yet (Inc.4c: a real user whose Privy wallet isn't provisioned) —
   *  skipped exactly like an inactive user and retried on the next reload. */
  spawn(userId: string, config: CopybotConfig): Promise<R | null>;
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
  // 1. Spawn the boot/reload UNION: every ACTIVE user PLUS every user still holding an OPEN mirror row PLUS every
  //    user still owing a PENDING fee. The open-mirror set is the never-miss-CLOSE backstop (finding #134): a user
  //    STOPPED — or whose disabling was written — while the brain was DOWN is enabled:false (⇒ absent from
  //    listActiveUserIds), yet their positions sit on-chain. The pending-fee set is the fee-COLLECTION backstop
  //    (finding #3): a user who STOPPED after their last close left a pending fee has no open mirror either, so ONLY
  //    this set boots them (fee-sweep-only) to collect it — without it, feeSweep's booted-only filter (#155) never
  //    sees them and the fee is lost. All are spawned DRAINED: the disabled config keeps them OUT of the open fan-out
  //    (userConfigs, step 3), while reconcile + stop-close + sweeps run on their wallet until the stranded mirrors
  //    force-close. Each listing is guarded independently — a hiccup in one must neither block spawning from the
  //    others nor the existing refresh.
  let activeIds: string[];
  try {
    activeIds = await deps.listActiveUserIds();
  } catch (e) {
    deps.log.error(
      { e: (e as Error).message },
      'reload: listActiveUserIds failed → no new active users this pass',
    );
    activeIds = [];
  }
  let openMirrorIds: string[];
  try {
    openMirrorIds = await deps.listUserIdsWithOpenMirrors();
  } catch (e) {
    // The never-miss backstop query hiccuped; existing runtimes still refresh and the next reload retries. A
    // truly-stranded stopped user is re-spawned the moment this query succeeds again.
    deps.log.error(
      { e: (e as Error).message },
      'reload: listUserIdsWithOpenMirrors failed → no drain-only spawns this pass',
    );
    openMirrorIds = [];
  }
  let pendingFeeIds: string[];
  try {
    pendingFeeIds = await deps.listUserIdsWithPendingFees();
  } catch (e) {
    // The fee-collection backstop query hiccuped; existing runtimes still refresh and the next reload retries. A
    // user stranded with ONLY a pending fee is re-spawned the moment this query succeeds again.
    deps.log.error(
      { e: (e as Error).message },
      'reload: listUserIdsWithPendingFees failed → no fee-sweep-only spawns this pass',
    );
    pendingFeeIds = [];
  }
  const spawnedNow = new Set<string>();
  for (const userId of new Set([...activeIds, ...openMirrorIds, ...pendingFeeIds])) {
    if (deps.runtimes.has(userId)) continue;
    try {
      const config = await deps.loadConfig(userId);
      const rt = await deps.spawn(userId, config);
      if (rt === null) {
        // Not provisioned yet (Inc.4c: no resolvable wallet) → no runtime, no fan-out entry; retried next reload.
        deps.log.info({ userId }, 'reload: user not provisioned yet → runtime not spawned');
        continue;
      }
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

  // 1b. Boot-seed FORCE-CLOSE (finding #135): each freshly-spawned runtime reloaded its persisted open mirrors. Any
  //     whose leader is disabled/absent in the boot config — or whose user is globally stopped — is a STOP written
  //     while the brain was DOWN. The phase-2 prev/next diff below CANNOT catch it (a fresh spawn has no transition:
  //     its prev would equal its next), so replay it here from the "open mirror ⇒ started leader" invariant. A no-op
  //     on a healthy boot; the runtime's RECLOSE_GRACE_MS gate dedupes an in-flight prior close. Guarded per user so
  //     one failing replay never blocks the others (rug-exit-pending + the reconcile retry it anyway).
  for (const userId of spawnedNow) {
    const rt = deps.runtimes.get(userId);
    const boot = deps.userConfigs.get(userId);
    if (!rt || !boot) continue;
    try {
      await rt.applyBootStopCloses(boot);
    } catch (e) {
      deps.log.error(
        { e: (e as Error).message, userId },
        'reload: boot stop-close failed → reconcile/next reload retries',
      );
    }
  }

  // 2. Refresh EVERY existing runtime (including deactivated ones — retention, see module doc). STOP =
  // FORCE-CLOSE (SPEC §4.3): diff the config we were RUNNING (prev, the last loaded value in memory — never a
  // stale/boot snapshot, so a restart can't replay an old stop) against the fresh load. Two failure domains are
  // kept DISTINCT so each logs the TRUTH: a failed LOAD leaves the previous config standing; a failure AFTER the
  // fresh config is committed (setConfig) means the new config IS live — only the stop-close application failed.
  for (const rt of deps.runtimes.values()) {
    if (spawnedNow.has(rt.userId)) continue; // just spawned — its boot stop-closes ran in 1b, nothing to diff yet
    const prev = rt.getConfig();
    let next: CopybotConfig;
    try {
      next = await deps.loadConfig(rt.userId);
    } catch (e) {
      // The config READ failed → nothing was committed; the previous config genuinely stands.
      deps.log.error(
        { e: (e as Error).message, userId: rt.userId },
        'reload: user config refresh failed → previous config stands (retried next reload)',
      );
      continue;
    }
    try {
      rt.setConfig(next);
      deps.userConfigs.set(rt.userId, next); // the fan-out targets from this live view — NOW committed
      await rt.applyStopCloses(prev, next);
    } catch (e) {
      // The fresh config was already committed above; only applying the stop-closes failed. Say so honestly — the
      // old "previous config stands" was a lie that hid a lost stop transition. STOP = force-close is idempotent, so
      // reconcile / the next reload re-applies it.
      deps.log.error(
        { e: (e as Error).message, userId: rt.userId },
        'reload: stop-close apply failed → new config committed, stop-close retried by reconcile/next reload',
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
