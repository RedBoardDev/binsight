/**
 * Copy-bot · runtime config — Zod schema + fail-safe parse.
 *
 * `parseConfig` deep-merges a (possibly partial / older-shape) stored blob onto the defaults, then validates — so a
 * missing or newly-added field falls back to its default instead of breaking the whole config. A STRUCTURALLY
 * invalid blob fails CLOSED (SPEC §12): it yields `STOPPED_CONFIG_DEFAULTS` (enabled:false + global kill switch ON),
 * never the permissive defaults — a corrupt blob must not silently re-arm a stopped bot (the adapter logs loudly).
 * Also migrates the legacy FLAT blob (`{leader, sizing, caps, twoSidedMode}`) into the two-tier shape so an
 * existing dev config is preserved.
 */
import { z } from 'zod';
import type { CapsConfig } from '../caps';
import type { FilterConfig } from '../filters';
import { PRIORITY_FEE_TIERS, type PriorityFeeConfig } from '../priority-fee';
import { RUG_SL_MAX_WINDOW_SECONDS, type RugSlConfig } from '../rug-sl';
import type { SizingConfig } from '../sizing';
import {
  CONFIG_DEFAULTS,
  DEFAULT_LEADER_ADDRESS,
  STOPPED_CONFIG_DEFAULTS,
  USER_DEFAULTS,
} from './defaults';
import {
  type CopybotConfig,
  type ExecutionConfig,
  type LeaderSettings,
  TWO_SIDED_MODES,
  type UserSettings,
} from './types';

// Zod mirrors of the reused domain interfaces — `satisfies` keeps each schema in lock-step with its interface.
const SizingSchema = z.object({
  tradeRatioPct: z.number().nullable(),
  maxTradeSizeSol: z.number().positive(),
  minPositionSizeSol: z.number().nonnegative(),
  solReserveSol: z.number().nonnegative(),
  onInsufficient: z.enum(['skip', 'reduceToFit']),
}) satisfies z.ZodType<SizingConfig>;

const CapsSchema = z.object({
  killSwitchGlobal: z.boolean(),
  killSwitchLeader: z.boolean(),
  maxOpenPositions: z.number().int().nonnegative().nullable(),
  maxConcurrentPerToken: z.number().int().nonnegative().nullable(),
  maxOpensPerWindow: z.number().int().nonnegative().nullable(),
  windowMinutes: z.number().nonnegative().nullable(),
  maxTotalExposureSol: z.number().nonnegative().nullable(),
}) satisfies z.ZodType<CapsConfig>;

const TwoSidedSchema = z.enum(TWO_SIDED_MODES);

const FilterConfigSchema = z.object({
  ignoredTokens: z.array(z.string()),
  singlePoolPerToken: z.boolean(),
  minPriceRangePercent: z.number().nullable(),
  minTokenAgeHours: z.number().nullable(),
  minMarketCapUsd: z.number().nullable(),
  min24hVolumeUsd: z.number().nullable(),
  maxPriceChangePercent: z.number().nullable(),
  minJupOrganicScore: z.number().nullable(),
  minHolders: z.number().nullable(),
}) satisfies z.ZodType<FilterConfig>;

const ExecutionSchema = z.object({
  slippageBps: z.number().nonnegative(),
  dustTokenRaw: z.number().int().nonnegative(),
  minSellOutLamports: z.number().int().nonnegative(),
  reshapeBinDeadbandSol: z.number().nonnegative(),
  reshapeBinDeadbandToken: z.number().nonnegative(),
}) satisfies z.ZodType<ExecutionConfig>;

const PriorityFeeSchema = z.object({
  tier: z.enum(PRIORITY_FEE_TIERS),
  maxCapSol: z.number().nonnegative(),
}) satisfies z.ZodType<PriorityFeeConfig>;

const RugSlSchema = z.object({
  enabled: z.boolean(),
  dropPercent: z.number().nonnegative(),
  // Bounded to the tracker's retention: a window longer than RugSlTracker retains could never be observed, so the
  // stop-loss would silently never fire. Reject it at write time (loud) instead of capping it invisibly (finding #154).
  windowSeconds: z
    .number()
    .positive()
    .max(
      RUG_SL_MAX_WINDOW_SECONDS,
      `windowSeconds cannot exceed ${RUG_SL_MAX_WINDOW_SECONDS}s (the rug-SL price-window retention)`,
    ),
}) satisfies z.ZodType<RugSlConfig>;

const UserSchema = z
  .object({
    enabled: z.boolean(),
    sizing: SizingSchema,
    caps: CapsSchema,
    twoSidedMode: TwoSidedSchema,
    filters: FilterConfigSchema,
    execution: ExecutionSchema,
    priorityFee: PriorityFeeSchema,
    rugSl: RugSlSchema,
    infiniteAdd: z.boolean(),
    claimFloorSol: z.number().nonnegative(),
    jitoEnabled: z.boolean(),
    priorityFeeOracle: z.boolean(),
  })
  .strict() satisfies z.ZodType<UserSettings>;

const LeaderSchema = z
  .object({
    address: z.string().min(1),
    enabled: z.boolean(),
    maxTotalExposureSol: z.number().nonnegative().nullable(),
    overrides: z
      .object({
        sizing: SizingSchema.partial().optional(),
        twoSidedMode: TwoSidedSchema.optional(),
        filters: FilterConfigSchema.partial().optional(),
        execution: ExecutionSchema.partial().optional(),
        priorityFee: PriorityFeeSchema.partial().optional(),
        rugSl: RugSlSchema.partial().optional(),
        infiniteAdd: z.boolean().optional(),
        claimFloorSol: z.number().nonnegative().optional(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<LeaderSettings>;

export const CopybotConfigSchema = z
  .object({ user: UserSchema, leaders: z.array(LeaderSchema) })
  .strict() satisfies z.ZodType<CopybotConfig>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
// A config BLOB must be a plain object: an array is `typeof 'object'` but can't be a config — treating it as an
// empty partial would parse it into the PERMISSIVE defaults (a fail-open hole for a corrupt/truncated write).
const isConfigShaped = (v: unknown): v is Obj => isObj(v) && !Array.isArray(v);

/** A stored legacy FLAT blob = `{leader, sizing, caps, twoSidedMode}` (no `user`). */
function isLegacyFlat(o: Obj): boolean {
  return !('user' in o) && ('sizing' in o || 'leader' in o);
}

/** Reshape a legacy flat blob into the two-tier candidate (then merged + validated like any other).
 *  The single legacy leader stays ENABLED: a flat blob means the bot was already running that leader — the
 *  stopped-by-default rule only applies to NEWLY-ADDED leaders, never to a migration of a live config. */
function fromLegacyFlat(o: Obj): Obj {
  return {
    user: { sizing: o.sizing, caps: o.caps, twoSidedMode: o.twoSidedMode },
    leaders: [{ address: o.leader ?? DEFAULT_LEADER_ADDRESS, enabled: true, overrides: {} }],
  };
}

/** Deep-merge a partial user block onto the user defaults (nested sizing/caps merged field-by-field). */
function mergeUser(partial: unknown): UserSettings {
  const p = isObj(partial) ? partial : {};
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : USER_DEFAULTS.enabled,
    sizing: { ...USER_DEFAULTS.sizing, ...(isObj(p.sizing) ? p.sizing : {}) },
    caps: { ...USER_DEFAULTS.caps, ...(isObj(p.caps) ? p.caps : {}) },
    twoSidedMode: (p.twoSidedMode as UserSettings['twoSidedMode']) ?? USER_DEFAULTS.twoSidedMode,
    filters: { ...USER_DEFAULTS.filters, ...(isObj(p.filters) ? p.filters : {}) },
    execution: { ...USER_DEFAULTS.execution, ...(isObj(p.execution) ? p.execution : {}) },
    priorityFee: { ...USER_DEFAULTS.priorityFee, ...(isObj(p.priorityFee) ? p.priorityFee : {}) },
    rugSl: { ...USER_DEFAULTS.rugSl, ...(isObj(p.rugSl) ? p.rugSl : {}) },
    infiniteAdd: typeof p.infiniteAdd === 'boolean' ? p.infiniteAdd : USER_DEFAULTS.infiniteAdd,
    claimFloorSol:
      typeof p.claimFloorSol === 'number' ? p.claimFloorSol : USER_DEFAULTS.claimFloorSol,
    jitoEnabled: typeof p.jitoEnabled === 'boolean' ? p.jitoEnabled : USER_DEFAULTS.jitoEnabled,
    priorityFeeOracle:
      typeof p.priorityFeeOracle === 'boolean'
        ? p.priorityFeeOracle
        : USER_DEFAULTS.priorityFeeOracle,
  } as UserSettings;
}

/** Normalize the leaders list (each leader gets defaulted enabled/overrides); empty/missing ⇒ the default leader.
 *  A leader whose `enabled` bit was never persisted defaults to STOPPED (SPEC §4.3): a just-added leader must
 *  never start copying before the user presses Start (the legacy FLAT migration sets `enabled:true` explicitly). */
function mergeLeaders(raw: unknown): LeaderSettings[] {
  if (!Array.isArray(raw) || raw.length === 0) return CONFIG_DEFAULTS.leaders;
  return raw.map((l) => {
    const o = isObj(l) ? l : {};
    return {
      address: typeof o.address === 'string' ? o.address : DEFAULT_LEADER_ADDRESS,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
      maxTotalExposureSol: typeof o.maxTotalExposureSol === 'number' ? o.maxTotalExposureSol : null,
      overrides: isObj(o.overrides) ? (o.overrides as LeaderSettings['overrides']) : {},
    };
  });
}

/**
 * Parse a stored blob into a validated config. null/'' (genuine first run) ⇒ full defaults; valid/partial ⇒ merged
 * onto defaults. A STRUCTURALLY INVALID blob (unparseable JSON, non-object, or failing the final schema) fails
 * CLOSED to `STOPPED_CONFIG_DEFAULTS` — returning the permissive defaults here would flip `enabled:true` /
 * `killSwitchGlobal:false` and silently re-arm a stopped bot on corruption (SPEC §12).
 */
export function parseConfig(raw: string | null): CopybotConfig {
  if (raw === null || raw === '') return CONFIG_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return STOPPED_CONFIG_DEFAULTS;
  }
  if (!isConfigShaped(parsed)) return STOPPED_CONFIG_DEFAULTS;
  const src = isLegacyFlat(parsed) ? fromLegacyFlat(parsed) : parsed;
  const candidate: CopybotConfig = {
    user: mergeUser(src.user),
    leaders: mergeLeaders(src.leaders),
  };
  const result = CopybotConfigSchema.safeParse(candidate);
  return result.success ? result.data : STOPPED_CONFIG_DEFAULTS;
}

/** Whether a stored blob is a clean, fully-valid config (used by the adapter to warn loudly on corruption). */
export function isValidConfigBlob(raw: string | null): boolean {
  if (raw === null || raw === '') return false;
  try {
    const parsed = JSON.parse(raw);
    if (!isConfigShaped(parsed)) return false;
    const src = isLegacyFlat(parsed) ? fromLegacyFlat(parsed) : parsed;
    return CopybotConfigSchema.safeParse({
      user: mergeUser(src.user),
      leaders: mergeLeaders(src.leaders),
    }).success;
  } catch {
    return false;
  }
}
