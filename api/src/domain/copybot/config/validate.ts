/**
 * Copy-bot · runtime config — WRITE-TIME policy validation (PURE, no I/O). Runs on every persist (ConfigStore.save
 * + the CLI) AFTER the structural Zod validation: the schema checks the SHAPE, this checks the PRODUCT RULES a
 * structurally-valid config can still break. Returns typed errors (empty array = accepted) so callers can render
 * a precise message instead of a generic "invalid config".
 */
import type { CopybotConfig } from './types';

/** Max leaders STARTED (enabled) simultaneously = Valhalla max, SPEC §4.3. Configured-but-stopped are unlimited. */
export const MAX_STARTED_LEADERS = 4;

/** One write-time policy violation. `code` is a stable identifier (never prose — callers switch on it). */
export type ConfigWriteError = {
  code: 'too_many_started_leaders';
  /** How many leaders the rejected config had enabled. */
  startedCount: number;
  /** The cap that was exceeded (= MAX_STARTED_LEADERS). */
  max: number;
};

/** Validate the product rules of a config about to be persisted. Empty array = accepted. Pure. */
export function validateConfigWrite(cfg: CopybotConfig): ConfigWriteError[] {
  const errors: ConfigWriteError[] = [];
  const startedCount = cfg.leaders.filter((l) => l.enabled).length;
  if (startedCount > MAX_STARTED_LEADERS) {
    errors.push({ code: 'too_many_started_leaders', startedCount, max: MAX_STARTED_LEADERS });
  }
  return errors;
}

/** Thrown by write paths (store/CLI) when `validateConfigWrite` rejects — carries the typed errors. */
export class InvalidConfigWriteError extends Error {
  constructor(readonly errors: ConfigWriteError[]) {
    super(`config write rejected: ${errors.map((e) => e.code).join(', ')}`);
    this.name = 'InvalidConfigWriteError';
  }
}
