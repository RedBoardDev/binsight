/**
 * Copy-bot · runtime config persistence (`copybot_configs` table, ONE row per user — SPEC §12, replaces the single
 * `settings['copybot.config']` blob). The web/CLI writes here; the bot reads/reloads here. One JSON blob per row =
 * an atomic per-user config swap (no half-applied multi-row update).
 *
 * - `load(userId)` is fail-safe AND fail-CLOSED: a missing row (genuine first run) yields the full defaults; a
 *   CORRUPT blob does NOT (returning the permissive `enabled:true`/`killSwitchGlobal:false` defaults would silently
 *   re-enable trading — a safety switch that fails OPEN). On corruption it returns that user's last known-good
 *   config with the GLOBAL kill switch FORCED ON (or, if none is cached yet, `parseConfig`'s STOPPED defaults),
 *   logged LOUDLY (Rule 11). It never throws, so a read can't crash the bot.
 * - `save(userId, cfg)` VALIDATES (schema + write policy, e.g. the started-leaders cap) and throws on an invalid
 *   config: the web/CLI caller must get a clear error, never persist junk.
 * - `seedIfAbsent(userId)` writes the defaults on first boot so the web has a concrete config to edit.
 * - `listActiveUserIds()` = the users whose parsed config is ENABLED (fail-closed parse ⇒ a corrupt row is never
 *   active) — the multi-user brain boot list (increment 3).
 */
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  CONFIG_DEFAULTS,
  type CopybotConfig,
  CopybotConfigSchema,
  InvalidConfigWriteError,
  isValidConfigBlob,
  parseConfig,
  validateConfigWrite,
} from '@/domain/copybot/config';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { copybotConfigs } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

/**
 * Return a copy of `cfg` with the GLOBAL kill switch forced ON. Used to fail CLOSED on a corrupt config blob:
 * whatever the last-good config was, halt every leader's opens until the blob is repaired. `caps.killSwitchGlobal`
 * is the account-wide halt that `checkCaps` reads (see caps.ts / config/effective.ts).
 */
function withKillSwitchOn(cfg: CopybotConfig): CopybotConfig {
  return { ...cfg, user: { ...cfg.user, caps: { ...cfg.user.caps, killSwitchGlobal: true } } };
}

export class ConfigStore {
  /**
   * Per-user last cleanly-parsed config, cached on every VALID load (including genuine first-run defaults). A later
   * CORRUPT blob fails CLOSED to this last known-good with the kill switch forced ON — the user keeps their exits/
   * caps context — instead of dropping to the anonymous stopped defaults.
   */
  private readonly lastGood = new Map<string, CopybotConfig>();

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  private async readRaw(userId: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(copybotConfigs)
      .where(eq(copybotConfigs.userId, userId));
    return rows[0]?.config ?? null;
  }

  /** Current runtime config for `userId`. Unset ⇒ defaults; CORRUPT ⇒ fail-closed (last-good with the kill switch
   *  forced ON when cached, else `parseConfig`'s STOPPED defaults — never the permissive defaults). */
  async load(userId: string): Promise<CopybotConfig> {
    const raw = await this.readRaw(userId);
    if (raw !== null && !isValidConfigBlob(raw)) {
      // A stored blob exists but is corrupt/unparseable (partial write, manual edit, or a schema tightening that now
      // rejects the old shape). Returning the permissive DEFAULTS here would silently flip `enabled:true` /
      // `killSwitchGlobal:false` and re-enable trading within the ~5s reload — the safety switch would fail OPEN.
      // Fail CLOSED instead: last known-good with the global kill switch forced ON when we hold one; otherwise
      // `parseConfig(raw)` already yields the STOPPED defaults (enabled:false + kill switch ON, SPEC §12).
      // TODO(follow-up): config corruption warrants a PINNED operator alert; the ConfigStore has no CopyEvents emitter
      // wired in yet, so keep the loud error log here and add the pinned alert when the emitter is reachable.
      this.log.error(
        { userId, raw },
        'copybot config blob is invalid → FAIL-CLOSED (stopped until repaired)',
      );
      const cached = this.lastGood.get(userId);
      return cached ? withKillSwitchOn(cached) : parseConfig(raw);
    }
    const cfg = parseConfig(raw); // null ⇒ genuine first-run DEFAULTS; valid/partial ⇒ merged-and-validated config
    this.lastGood.set(userId, cfg); // cache the known-good config so the next corrupt blob can fail closed to it
    return cfg;
  }

  /** Persist a full config for `userId`. Validates shape (Zod) then write policy (started-leaders cap) → throws on
   *  invalid so the web/CLI caller never stores junk. */
  async save(userId: string, cfg: CopybotConfig): Promise<void> {
    const valid = CopybotConfigSchema.parse(cfg); // throws ZodError on invalid (loud, caller-facing)
    const writeErrors = validateConfigWrite(valid); // product rules (SPEC §4.3: ≤ MAX_STARTED_LEADERS enabled)
    if (writeErrors.length > 0) throw new InvalidConfigWriteError(writeErrors);
    const config = JSON.stringify(valid);
    const updatedAt = Date.now();
    await this.db
      .insert(copybotConfigs)
      .values({ userId, config, updatedAt })
      .onConflictDoUpdate({ target: copybotConfigs.userId, set: { config, updatedAt } });
  }

  /** First-boot seed: write the defaults if this user has no row, then return the effective config. */
  async seedIfAbsent(userId: string): Promise<CopybotConfig> {
    const raw = await this.readRaw(userId);
    if (raw !== null) return this.load(userId); // existing row → the same fail-closed read path as any load
    await this.save(userId, CONFIG_DEFAULTS);
    this.log.info({ userId }, 'copybot config seeded with DEFAULTS');
    return CONFIG_DEFAULTS;
  }

  /** Users whose stored config is ACTIVE (`user.enabled === true`). The parse fails CLOSED, so a corrupt row can
   *  never surface as an active user (it parses to enabled:false — SPEC §12). */
  async listActiveUserIds(): Promise<string[]> {
    const rows = await this.db
      .select({ userId: copybotConfigs.userId, config: copybotConfigs.config })
      .from(copybotConfigs);
    return rows.filter((r) => parseConfig(r.config).user.enabled).map((r) => r.userId);
  }

  /** EVERY user id with a stored config row — enabled, disabled, OR corrupt alike. This is the GLOBAL KILL target
   *  (SPEC §10/§13): an operator halt must reach every configured tenant, so it cannot filter on `enabled` the way
   *  `listActiveUserIds` does — a stopped or fail-closed user still owns `caps.killSwitchGlobal` we force ON. */
  async allUserIds(): Promise<string[]> {
    const rows = await this.db.select({ userId: copybotConfigs.userId }).from(copybotConfigs);
    return rows.map((r) => r.userId);
  }
}
