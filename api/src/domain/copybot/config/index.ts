/**
 * Copy-bot · runtime config — public surface. Import from `@/domain/copybot/config`.
 */

export { CONFIG_DEFAULTS, DEFAULT_LEADER_ADDRESS, USER_DEFAULTS } from './defaults';
export { addLeader, coerceValue, getAtPath, MAX_LEADERS, removeLeader, setAtPath } from './edit';
export { effectiveFor } from './effective';
export { CopybotConfigSchema, isValidConfigBlob, parseConfig } from './schema';
export * from './types';
