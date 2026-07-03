/**
 * Copy-bot · operator admin surface (SPEC §10 owner-only admin + §13 away-from-desk kill path).
 *
 * Read-only over the bot runtime — it NEVER touches the brain/coffre processes directly. It only:
 *  - reads the `copybot_status` heartbeats (→ online/stale + the per-user/per-leader snapshot the web renders),
 *  - flips every user's persisted `caps.killSwitchGlobal` ON and fires ONE control ping so every runtime early-
 *    reloads the halted config in <100ms (the DB stays the single source of truth — the ping only triggers an
 *    early re-read, never carries state), and
 *  - pulls the recent pinned SYSTEM alerts (quarantined forged commands, fatal stops, blind detectors).
 *
 * All state changes go through `ConfigStore.save` (schema + write-policy validated) and a plain Postgres read —
 * so the API process needs no bot code on its hot path, and the kill is idempotent + no-miss.
 */
import { desc, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { ConfigStore } from '@/copybot/config-store';
import type { CopybotConfig } from '@/domain/copybot/config';
import { CODE_REGISTRY, type CopyCode } from '@/domain/copybot/observability/codes';
import { isOnline, type StatusProcess } from '@/domain/copybot/status';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { copybotStatus, copyJournal } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

/** Default page size for the quarantine/alert feed (newest-first). Bounded so the panel query stays cheap. */
export const QUARANTINE_LIMIT_DEFAULT = 50;
/** Hard ceiling on the quarantine page size — an operator can page but never ask for an unbounded scan. */
export const QUARANTINE_LIMIT_MAX = 200;

/**
 * The operator alerts surfaced in the admin "quarantine / alerts" panel: the pinned SYSTEM codes — a forged/
 * malformed `cmd:sign` dead-lettered (`system.command_quarantined`), a fatal stop (`system.fatal`), and a blind
 * detector (`system.detection_stale`). DERIVED from the registry (not hand-listed) so a new pinned SYSTEM code
 * appears here automatically and the two can never drift. Per-position lifecycle/failsafe alerts are NOT included
 * — those are normal activity for the user feed, not the operator's process-level quarantine surface.
 */
export const QUARANTINE_ALERT_CODES: CopyCode[] = (Object.keys(CODE_REGISTRY) as CopyCode[]).filter(
  (code) => CODE_REGISTRY[code].pinned === true && CODE_REGISTRY[code].category === 'SYSTEM',
);

/** One process's health, derived from the freshness of its heartbeat row (staleness is the only honest signal). */
export type ProcessStatus = {
  /** Last heartbeat time (ms). */
  ts: number;
  /** How long ago the last heartbeat was (ms) — the web renders "online / Ns ago". */
  ageMs: number;
  /** Beat within the stale window ⇒ online. A crashed process can't flip a flag, so this is derived, not stored. */
  online: boolean;
  /** The process-specific snapshot (loose jsonb: brain users[]/leaders[], coffre signing state). Rendered defensively. */
  detail: unknown;
};

export type CopybotStatusView = {
  brain: ProcessStatus | null;
  coffre: ProcessStatus | null;
};

/** A quarantine/alert row projected for the admin panel (a subset of `copy_journal`). */
export type QuarantineRow = {
  id: number;
  ts: number;
  code: string | null;
  severity: string;
  wallet: string | null;
  userId: string | null;
  correlationId: string | null;
  reason: string | null;
  leader: string | null;
  detail: unknown;
};

/** Publish a `config-changed` control ping so every bot runtime early-reloads the DB config (<100ms). */
export type PublishConfigChanged = () => Promise<void>;

export class CopybotAdminService {
  constructor(
    private readonly db: Db,
    private readonly configStore: ConfigStore,
    private readonly publishConfigChanged: PublishConfigChanged,
    private readonly log: Logger,
  ) {}

  /** Process health for the admin panel: each heartbeat row → online/stale + its snapshot. `now` is injectable for tests. */
  async status(now: number = Date.now()): Promise<CopybotStatusView> {
    const rows = await this.db.select().from(copybotStatus);
    const byProcess = new Map(rows.map((r) => [r.process, r]));
    const view = (process: StatusProcess): ProcessStatus | null => {
      const row = byProcess.get(process);
      if (!row) return null;
      return {
        ts: row.ts,
        ageMs: Math.max(0, now - row.ts),
        online: isOnline(row.ts, now),
        detail: row.detail,
      };
    };
    return { brain: view('brain'), coffre: view('coffre') };
  }

  /**
   * GLOBAL KILL: force `caps.killSwitchGlobal` ON for EVERY user, then fire ONE control ping so the halt applies in
   * <100ms (SPEC §13). Idempotent — a user already killed (including a corrupt blob, which `load` fail-closes to
   * kill-ON) is SKIPPED, so we never re-write (and never CLOBBER a corrupt blob back to defaults). Returns how many
   * user configs the halt now covers (stable across repeated calls).
   */
  async killGlobal(): Promise<{ killed: number }> {
    const userIds = await this.configStore.allUserIds();
    for (const userId of userIds) {
      const cfg = await this.configStore.load(userId);
      // Already halted (operator killed earlier, or a corrupt blob that fail-closes to kill-ON) → don't re-save.
      // Re-saving a corrupt blob's fail-closed config would overwrite the (unparseable but real) stored config.
      if (cfg.user.caps.killSwitchGlobal) continue;
      const killed: CopybotConfig = {
        ...cfg,
        user: { ...cfg.user, caps: { ...cfg.user.caps, killSwitchGlobal: true } },
      };
      await this.configStore.save(userId, killed);
    }
    // One ping AFTER all rows are persisted: a runtime that reloads mid-loop then reads an already-killed DB.
    await this.publishConfigChanged();
    this.log.warn(
      { users: userIds.length },
      'copybot GLOBAL KILL engaged (killSwitchGlobal forced ON for all users)',
    );
    return { killed: userIds.length };
  }

  /** Recent pinned SYSTEM alerts (quarantined commands / fatal / detection-stale), newest first, bounded. */
  async quarantine(limit: number = QUARANTINE_LIMIT_DEFAULT): Promise<QuarantineRow[]> {
    const bounded = Math.min(
      QUARANTINE_LIMIT_MAX,
      Math.max(1, Math.floor(limit) || QUARANTINE_LIMIT_DEFAULT),
    );
    return this.db
      .select({
        id: copyJournal.id,
        ts: copyJournal.ts,
        code: copyJournal.code,
        severity: copyJournal.severity,
        wallet: copyJournal.wallet,
        userId: copyJournal.userId,
        correlationId: copyJournal.correlationId,
        reason: copyJournal.reason,
        leader: copyJournal.leader,
        detail: copyJournal.detail,
      })
      .from(copyJournal)
      .where(inArray(copyJournal.code, QUARANTINE_ALERT_CODES))
      .orderBy(desc(copyJournal.ts))
      .limit(bounded);
  }
}
