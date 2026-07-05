/**
 * Copy-bot · runtime config — DEFAULTS (the spec-locked values; see docs/reference/copybot-settings.md).
 * Defaults only seed a FRESH config + the parse fallback — an existing stored config is preserved.
 */
import { CAPS_DEFAULTS } from '../caps';
import { FILTERS_ALL_OFF } from '../filters';
import type { CopybotConfig, UserSettings } from './types';

/** The single followed leader (was the `COPYBOT_LEADER` env default). */
export const DEFAULT_LEADER_ADDRESS = '8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ';

/**
 * Per-bin token-leg reshape deadband, in RAW base units (two-sided reshape only). Unlike its SOL sibling
 * `reshapeBinDeadbandSol`, which is decimals-STABLE (SOL is always 9 decimals), this threshold is decimals-DEPENDENT
 * and no single raw value is correct for every mint: relative to typical per-bin token amounts, 100 raw units is
 * negligible on a high-decimals mint (→ fires on near-zero deltas: dust-sized reshape buys / fee bleed) yet large on
 * a low-decimals mint (→ suppresses real moves: reshape fidelity loss). It is left at 100 (calibrated for the common
 * high-decimals SPL/LP mint); the complete fix scales the deadband by the position mint's decimals at the reshape
 * site (the `planTwoSidedReshape` caller in the brain runtime), which lives outside this config module. See idx17.
 */
const RESHAPE_BIN_DEADBAND_TOKEN_RAW = 100;

export const USER_DEFAULTS: UserSettings = {
  enabled: true,
  sizing: {
    tradeRatioPct: 100,
    maxTradeSizeSol: 1.0,
    minPositionSizeSol: 0.05,
    solReserveSol: 0.05,
    onInsufficient: 'skip',
  }, // 100% = follow the leader, capped by maxTradeSize (spec §3)
  caps: { ...CAPS_DEFAULTS },
  twoSidedMode: 'off',
  filters: { ...FILTERS_ALL_OFF }, // all entry filters OFF by default; an enabled filter ENFORCES (no shadow mode)
  execution: {
    slippageBps: 100, // 1% — permissive enough to land
    dustTokenRaw: 0, // sell any residual by default
    minSellOutLamports: 50_000, // ~0.00005 SOL floor: below it a residual sell isn't worth the fees
    reshapeBinDeadbandSol: 0.0002, // LOW: reshapes are event-driven (not arb), so a low threshold maximizes fidelity
    reshapeBinDeadbandToken: RESHAPE_BIN_DEADBAND_TOKEN_RAW, // raw base-unit per-bin token-leg threshold (decimals-dependent — see the constant's rationale)
  },
  priorityFee: { tier: 'medium', maxCapSol: 0.005 }, // capped CU price on every tx (spec §5)
  rugSl: { enabled: true, dropPercent: 40, windowSeconds: 60 }, // crash safety exit on by default (spec §7)
  infiniteAdd: false, // copy only the first deposit by default; removes are always followed (spec §8, Valhalla)
  claimFloorSol: 0.01, // mirror a leader fee-claim only if ≥ ~0.01 SOL (≈ Valhalla's $2 floor; skip dust claims)
  jitoEnabled: false, // Jito bundle landing is opt-in (needs a block-engine URL); default = plain RPC send
  priorityFeeOracle: false, // live fee estimate is opt-in; default = static tier (no extra RPC, behavior unchanged)
};

export const CONFIG_DEFAULTS: CopybotConfig = {
  user: USER_DEFAULTS,
  leaders: [
    { address: DEFAULT_LEADER_ADDRESS, enabled: true, maxTotalExposureSol: null, overrides: {} },
  ],
};

/**
 * The fail-CLOSED parse fallback (SPEC §12): a STRUCTURALLY INVALID stored blob must never re-arm a stopped bot,
 * so `parseConfig` yields the defaults in a STOPPED state — master switch OFF and global kill switch ON. A genuine
 * first run (no blob at all) still gets the permissive `CONFIG_DEFAULTS`; only corruption lands here.
 */
export const STOPPED_CONFIG_DEFAULTS: CopybotConfig = {
  ...CONFIG_DEFAULTS,
  user: {
    ...USER_DEFAULTS,
    enabled: false,
    caps: { ...USER_DEFAULTS.caps, killSwitchGlobal: true },
  },
};

/**
 * The brand-new NON-SYSTEM first-run seed (idx24: seeding a real user must never auto-arm them). `seedIfAbsent` gives
 * the SYSTEM/bench (mono-user owner) tenant the armed `CONFIG_DEFAULTS` so its runtime auto-follows the default leader
 * on boot; seeding those SAME armed defaults to a real multi-user tenant would silently open positions on a leader they
 * never chose. So a fresh non-SYSTEM tenant boots INERT: master switch OFF (`user.enabled:false`) and the default leader
 * STOPPED (`enabled:false`, so it is not a "started" leader — `validateConfigWrite` counts enabled leaders). The global
 * kill switch stays at its normal OFF: a not-yet-armed user is NOT the operator emergency-halt that
 * `STOPPED_CONFIG_DEFAULTS` (kill switch ON) encodes for a corrupt blob — the user simply arms the bot themselves.
 */
export const STOPPED_SEED_CONFIG: CopybotConfig = {
  ...CONFIG_DEFAULTS,
  user: { ...USER_DEFAULTS, enabled: false },
  leaders: CONFIG_DEFAULTS.leaders.map((l) => ({ ...l, enabled: false })),
};
