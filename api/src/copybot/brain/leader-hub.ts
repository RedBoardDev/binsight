/**
 * Copy-bot · Inc.3b step 4-5 — LeaderHub: per-leader detection + the event fan-out router (INC3B-PLAN §1/§2).
 *
 * One entry per WATCHED leader: its own `LeaderDetector` (cursor/seen/in-flight), its own
 * `LeaderPositionTracker` (dedup/state — detection-scoped, applied ONCE here, never per user), and its own poll
 * health (per-leader stale counters/alerts). One process-level poll loop iterates entries SEQUENTIALLY
 * (single-flight per detector is built into `LeaderDetector.poll`); ONE `HeliusTxSubscriber` watches every entry.
 *
 * Fan-out: a live, tracker-accepted event targets `usersCopying(leader)` ∪ the runtimes that already OWN the
 * event's position — a close must reach a user whose leader was stopped/removed mid-flight (never-miss pillar).
 * Each target is enqueued under its own try/catch: one runtime's throw can never starve the others.
 *
 * Leader-set changes (`applyLeaderSet`): an ADDED leader is seeded with `poll('replay')` (cursor+tracker set,
 * replay events dropped — the forward-only rule of SPEC §4.3) BEFORE it is watched, so nothing pre-add is ever
 * copied and the replay/live pair is contiguous. A REMOVED leader is unwatched + marked `draining` but its entry
 * is RETAINED (still polled) while any runtime holds an open mirror / pending safety-close for it — its own close
 * events must stay detectable until every mirror is confirmed gone. In-flight classification is never cancelled:
 * removal only stops scheduling.
 */
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import type { Logger } from 'pino';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import type { CopybotConfig } from '@/domain/copybot/config';
import type { DetectedEvent } from '@/domain/copybot/events';
import { usersCopying } from '@/domain/copybot/fan-out';
import type { EventSource } from '@/domain/copybot/leader-detector';
import { LeaderPositionTracker } from '@/domain/copybot/leader-position';
import {
  DETECTION_STALE_FAILURES,
  detectionHealthy,
  shouldAlertDetectionStale,
} from '@/domain/copybot/status';
import { classifyInstruction } from '@/domain/dlmm';
import { hasDlmmEvents } from '@/infrastructure/solana/dlmm/dlmm-event-decoder';

/** The detector surface the hub drives (structural — `LeaderDetector` satisfies it; tests stub it). */
export interface HubDetector {
  poll(source?: EventSource): Promise<void>;
  onWsSignature(signature: string, tx?: ParsedTransactionWithMeta | null): Promise<void>;
}

/** The WS-trigger surface the hub drives (structural — `HeliusTxSubscriber` satisfies it; tests stub it). */
export interface TxWatcher {
  watch(
    wallet: string,
    onActivity: (signature: string, logs: string[], tx: ParsedTransactionWithMeta | null) => void,
  ): void;
  unwatch(wallet: string): void;
  onReconnect(cb: () => void): void;
}

/** The per-user runtime surface the fan-out drives (structural — `UserRuntime` satisfies it; tests stub it). */
export interface FanOutRuntime {
  readonly userId: string;
  /** Enqueue-only (synchronous): per-position serialization happens inside the runtime's own queue. */
  onEvent(e: DetectedEvent, source: EventSource, leader: string, eventCount: number): void;
  /** Open mirror, reserved open, or in-flight multi-tx stash for this LEADER position. */
  ownsLeaderPosition(leaderPosition: string): boolean;
  /** The runtime's own emitter — per-user failure isolation rows stay attributed to the failing tenant. */
  events: Pick<CopyEvents, 'system'>;
}

/** One watched leader (INC3B-PLAN §1). */
interface LeaderEntry {
  leader: string;
  detector: HubDetector;
  tracker: LeaderPositionTracker;
  pollFailures: number; // CONSECUTIVE poll failures (reset on a success) — per leader
  lastPollAt: number | null; // ms of the last SUCCESSFUL cursor poll — per leader
  staleAlerted: boolean; // once-per-episode gate for the per-leader detection-stale alert
  draining: boolean; // removed from the leader set; retained (still polled) while shouldRetainLeader says so
}

export interface LeaderHubDeps {
  log: Logger;
  /** SHARED detection-context emitter (SYSTEM-bound): detection is one on-chain fact — `detect.routed` /
   *  `detect.gap` / `system.detection_stale` are emitted ONCE here, never fabricated per user. */
  events: CopyEvents;
  /** One detector per leader, bound to ITS deps (`makeDetectionDeps` is pk-parameterized). */
  makeDetector: (
    leader: string,
    onEvent: (e: DetectedEvent, source: EventSource) => void,
    onGap: (signature: string, attempts: number) => void,
  ) => HubDetector;
  /** Live per-user configs (today: the single SYSTEM entry, refreshed by reloadConfig). */
  getConfigs: () => ReadonlyMap<string, CopybotConfig>;
  /** Live per-user runtimes (today: ONE SYSTEM runtime — multi-boot is 3b step 7). */
  getRuntimes: () => ReadonlyMap<string, FanOutRuntime>;
  /** True while ANY runtime still holds an open mirror / pending close for this leader (pure predicate wired by
   *  brain-main over `shouldRetainLeader` + each runtime's `leaderHoldings`). */
  retainLeader: (leader: string) => boolean;
  /** The WS trigger; absent in no-WS boots (detection then runs on the cursor poll alone). */
  watcher?: TxWatcher;
}

export class LeaderHub {
  private readonly entries = new Map<string, LeaderEntry>();

  constructor(private readonly deps: LeaderHubDeps) {
    // After a WS outage, catch up EVERY leader via its own poll (what slipped through is re-covered). Log-only
    // (matches the pre-hub wiring): a failed catch-up is retried by the next scheduled pollAll, which counts it.
    deps.watcher?.onReconnect(() => {
      for (const entry of this.entries.values()) {
        entry.detector
          .poll()
          .catch((e) =>
            this.deps.log.error({ e: (e as Error).message, leader: entry.leader }, 'catch-up poll'),
          );
      }
    });
  }

  /**
   * Reconcile the hub to the wanted leader set. ADDED leaders are replay-seeded BEFORE being watched (forward-only;
   * a replay failure discards the half-built entry so the next apply retries cleanly). Leaders no longer wanted are
   * unwatched + marked draining; a draining leader re-added is simply re-watched (its cursor never stopped).
   */
  async applyLeaderSet(next: ReadonlySet<string>): Promise<void> {
    for (const leader of next) {
      const existing = this.entries.get(leader);
      if (existing) {
        if (existing.draining) {
          existing.draining = false; // re-added mid-drain: its detector kept polling → no gap to fear
          this.watch(existing);
        }
        continue;
      }
      const entry = this.createEntry(leader);
      // Forward-only seed (SPEC §4.3): sets the cursor + tracker state; `route` drops source==='replay', so
      // nothing pre-add is copied. Contiguous with live by construction (nothing before the add is owed).
      await entry.detector.poll('replay');
      this.entries.set(leader, entry);
      this.watch(entry);
    }
    for (const entry of this.entries.values()) {
      if (!next.has(entry.leader) && !entry.draining) {
        entry.draining = true;
        this.deps.watcher?.unwatch(entry.leader);
      }
    }
    this.pruneDrained();
  }

  /** One sequential pass over every entry (the process-level POLL_MS loop). Per-leader failure isolation: one
   *  leader's throwing poll never blocks the others' completeness sweep. */
  async pollAll(): Promise<void> {
    this.pruneDrained();
    for (const entry of this.entries.values()) {
      try {
        await entry.detector.poll();
        this.onPollSuccess(entry);
      } catch (e) {
        this.deps.log.error({ e: (e as Error).message, leader: entry.leader }, 'poll');
        this.onPollFailure(entry);
      }
    }
  }

  /** Poll health for the heartbeat, aggregated CONSERVATIVELY: the stalest leader defines it (max consecutive
   *  failures, oldest lastPollAt; null while any leader never polled). Single leader ⇒ its exact values. */
  pollHealth(): { lastPollAt: number | null; pollFailures: number } {
    let lastPollAt: number | null = null;
    let pollFailures = 0;
    let first = true;
    for (const entry of this.entries.values()) {
      pollFailures = Math.max(pollFailures, entry.pollFailures);
      if (first) {
        lastPollAt = entry.lastPollAt;
        first = false;
      } else if (lastPollAt !== null) {
        lastPollAt = entry.lastPollAt === null ? null : Math.min(lastPollAt, entry.lastPollAt);
      }
    }
    return { lastPollAt, pollFailures };
  }

  /** Per-leader detection health for the v2 status payload (Inc.3b step 8 — replaces the poll singletons). */
  leaderHealth(): Array<{ leader: string; lastPollAt: number | null; pollFailures: number }> {
    return [...this.entries.values()].map((e) => ({
      leader: e.leader,
      lastPollAt: e.lastPollAt,
      pollFailures: e.pollFailures,
    }));
  }

  private createEntry(leader: string): LeaderEntry {
    // The detector callbacks close over the ENTRY (not a map lookup): the replay-seed runs BEFORE the entry is
    // registered, and its tracker application must not be lost.
    const entry: LeaderEntry = {
      leader,
      detector: undefined as unknown as HubDetector, // assigned on the next line (callbacks need `entry` first)
      tracker: new LeaderPositionTracker(),
      pollFailures: 0,
      lastPollAt: null,
      staleAlerted: false,
      draining: false,
    };
    entry.detector = this.deps.makeDetector(
      leader,
      (e, source) => this.route(entry, e, source),
      (signature, attempts) => this.onGap(leader, signature, attempts),
    );
    return entry;
  }

  private watch(entry: LeaderEntry): void {
    this.deps.watcher?.watch(entry.leader, (sig, logs, tx) => {
      // Gate on the DECODED tx when the WS delivered it (#32): its innerInstructions carry the DLMM CPI events
      // classify reads (#117) and NEVER truncate, so a big-bundle close whose 10KB `logMessages` dropped the DLMM
      // marker still fast-tracks (it was silently losing the low-latency path before). Only when the payload is
      // incomplete (`tx === null`) do we fall back to the (truncatable) log marker. Either way the completeness poll
      // stays the backstop — the WS is only a best-effort trigger, so a false negative costs latency, never a miss.
      const hasDlmm = tx ? hasDlmmEvents(tx) : logs.some((l) => l.includes(DLMM_PROGRAM_ID));
      this.deps.log.debug({ sig, hasDlmm, nLogs: logs.length, wsTx: tx !== null }, '📡 ws notif');
      if (hasDlmm)
        // Pass the delivered tx (finding #32): when the payload is complete the detector classifies from it,
        // skipping the RPC re-fetch; `null` (incomplete) → it falls back to the fetch.
        entry.detector
          .onWsSignature(sig, tx)
          .catch((e) => this.deps.log.error({ e: (e as Error).message }, 'ws'));
    });
  }

  /** Delete the draining entries nothing references anymore. Called between polls (never mid-poll: `pollAll` is
   *  sequential and awaits), after a set change, and by brain-main on reconcile ticks (Inc.3b step 6) — the
   *  retention inputs (open mirrors / pending closes) change exactly when the reconcile confirms closes, so a
   *  drained leader is released the tick its last mirror is confirmed gone, not one poll cycle later.
   *  In-flight WS classification keeps its closure — never cancelled. */
  pruneDrained(): void {
    for (const entry of this.entries.values()) {
      if (entry.draining && !this.deps.retainLeader(entry.leader))
        this.entries.delete(entry.leader);
    }
  }

  /** The impure fan-out router (INC3B-PLAN §2): tracker ONCE, drop replay/untracked, emit `detect.routed` ONCE,
   *  then enqueue into every target runtime under per-target isolation. */
  private route(entry: LeaderEntry, e: DetectedEvent, source: EventSource): void {
    // Dedup / tracker / replay-skip stay SYNCHRONOUS at ingest time (the tracker state must advance in the order
    // events arrive, before any handler runs). `apply` returns undefined for a leg with no position (no capital).
    const pos = entry.tracker.apply(e);
    this.deps.log.debug(
      {
        source,
        position: e.position,
        instr: e.instruction,
        depositSol: e.depositSol,
        posNull: !pos,
      },
      '👁️ onEvent in',
    );
    if (source === 'replay' || !pos) return; // forward-only: never copy a past open
    // ONE detection row per on-chain fact (SYSTEM context): duplicating it per user would fabricate N detection
    // rows for one event. `eventKey` = the per-leg correlation (sig:position) so the emit dedup keys uniquely PER
    // routed leg; WS + cursor-poll re-observations of the SAME leg correctly collapse to one row.
    const kind = classifyInstruction(e.instruction);
    void this.deps.events.emit('detect.routed', {
      stage: 'detect',
      outcome: 'detected',
      kind: kind ?? undefined,
      leader: entry.leader,
      pool: e.pool,
      leaderPosition: e.position,
      signature: e.signature,
      leaderSizeSol: e.depositSol || e.withdrawSol || e.claimSol,
      eventKey: `${e.signature}:${e.position}`,
      adminDetail: { instruction: e.instruction },
    });
    const runtimes = this.deps.getRuntimes();
    const targets = new Map<string, FanOutRuntime>();
    for (const uid of usersCopying(entry.leader, this.deps.getConfigs())) {
      const rt = runtimes.get(uid);
      if (rt) targets.set(uid, rt);
    }
    // Union clause: a runtime that OWNS the position stays a target even if its leader was stopped/removed
    // mid-flight — its close/resync must still be handled (per-user blocks gate any re-open via effectiveFor).
    for (const rt of runtimes.values()) {
      if (!targets.has(rt.userId) && rt.ownsLeaderPosition(e.position)) targets.set(rt.userId, rt);
    }
    for (const rt of targets.values()) {
      // Per-target isolation: `onEvent` only ENQUEUES, but a throw during enqueue for user A must never prevent
      // this loop from reaching user B — the event is never "consumed" by one runtime's failure.
      try {
        rt.onEvent(e, source, entry.leader, pos.eventCount);
      } catch (err) {
        rt.events.system('system.loop_errored', err, {
          stage: 'failsafe',
          outcome: 'failed',
          reason: 'loop_errored',
          leader: entry.leader,
          adminDetail: { loop: 'fan_out', position: e.position, signature: e.signature },
        });
      }
    }
  }

  /** A signature a detector could NOT resolve after its bounded retry → forced past to avoid stalling the cursor,
   *  surfaced as a LOUD per-leader gap (the reconcile backstop still covers closes). */
  private onGap(leader: string, signature: string, attempts: number): void {
    this.deps.events.emit('detect.gap', {
      stage: 'detect',
      outcome: 'failed',
      leader,
      signature,
      eventKey: `gap:${leader}:${signature}`, // gains the leader (3b): per-leader cursors gap independently
      adminDetail: { attempts },
    });
  }

  /** A leader's poll succeeded: stamp + reset ITS counter, re-arm ITS stale alert. Per-leader observability. */
  private onPollSuccess(entry: LeaderEntry): void {
    entry.lastPollAt = Date.now();
    entry.pollFailures = 0;
    // Poll-only health here — the reconcile counter lives in brain-main (wallet-level, not per-leader).
    if (detectionHealthy(entry.pollFailures, 0)) entry.staleAlerted = false;
  }

  /** A leader's poll failed: bump ITS counter and — after DETECTION_STALE_FAILURES in a row — emit the pinned
   *  "bot may be blind to THIS leader" alert ONCE per stale episode. Another leader's health is untouched. */
  private onPollFailure(entry: LeaderEntry): void {
    entry.pollFailures += 1;
    if (shouldAlertDetectionStale(entry.pollFailures, 0, entry.staleAlerted)) {
      entry.staleAlerted = true;
      this.deps.events.emit('system.detection_stale', {
        stage: 'failsafe',
        outcome: 'failed',
        leader: entry.leader,
        eventKey: `detection-stale:${entry.leader}:${Date.now()}`, // fresh per episode + per leader (3b)
        adminDetail: { pollFailures: entry.pollFailures, threshold: DETECTION_STALE_FAILURES },
      });
    }
  }
}
