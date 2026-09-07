/**
 * Copy-bot · runtime config — public surface. Import from `@/domain/copybot/config`.
 */

export {
  CONFIG_DEFAULTS,
  DEFAULT_LEADER_ADDRESS,
  STOPPED_CONFIG_DEFAULTS,
  STOPPED_SEED_CONFIG,
  USER_DEFAULTS,
} from './defaults';
export { addLeader, coerceValue, getAtPath, removeLeader, setAtPath } from './edit';
export { effectiveFor } from './effective';
export { CopybotConfigSchema, isValidConfigBlob, parseConfig } from './schema';
export * from './types';
export {
  type ConfigWriteError,
  InvalidConfigWriteError,
  MAX_STARTED_LEADERS,
  validateConfigWrite,
} from './validate';
