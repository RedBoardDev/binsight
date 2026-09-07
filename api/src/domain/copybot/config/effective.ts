/**
 * Copy-bot · runtime config — `effectiveFor(leader)`: the resolved config a handler consumes.
 *
 * `effective = merge(user defaults, leader overrides)`. Pure, per-event (no cache). The per-leader `enabled` switch
 * and the user master switch are folded into the resolved `caps` (`killSwitchLeader` / `killSwitchGlobal`) so the
 * existing `checkCaps` enforces them unchanged. A leader may only TIGHTEN the size cap, never raise it.
 */
import type { CapsConfig } from '../caps';
import type { FilterConfig } from '../filters';
import type { PriorityFeeConfig } from '../priority-fee';
import type { RugSlConfig } from '../rug-sl';
import type { SizingConfig } from '../sizing';
import type { CopybotConfig, EffectiveConfig, ExecutionConfig, TwoSidedMode } from './types';

/** Merge a sparse leader sizing override onto the user sizing. `maxTradeSizeSol` is lower-only (tighten, never raise). */
function mergeSizing(base: SizingConfig, ov?: Partial<SizingConfig>): SizingConfig {
  if (!ov) return base;
  const merged: SizingConfig = { ...base, ...ov };
  if (ov.maxTradeSizeSol !== undefined)
    merged.maxTradeSizeSol = Math.min(base.maxTradeSizeSol, ov.maxTradeSizeSol);
  return merged;
}

/** Merge a sparse filter override (per-leader, or env bridge) onto a base filter config. */
function mergeFilters(base: FilterConfig, ov?: Partial<FilterConfig>): FilterConfig {
  return ov ? { ...base, ...ov } : base;
}

/**
 * Force the transfer-fee guard ON for any TWO-SIDED flow (`twoSidedMode !== 'off'`). The two-sided deposit funds the
 * token leg through a flat ~0.1% haircut (`user-runtime` `depositableToken`) that a real Token-2022 `TransferFeeConfig`
 * mint defeats: the fee'd transfer lands SHORT, so the deposit fails (empty position orphan-closed + token swept back =
 * pure buy/sell/fee churn) or lands mis-composed — and every two-sided open of that mint repeats the loss (finding #165,
 * completing #105). Coupling `skipTransferFeeTokens` here — a fail-closed brick (an unreadable/unverifiable mint also
 * skips) — means a two-sided open of a fee'd mint can NEVER proceed. Returns a NEW config (never mutates the shared
 * `user.filters` reference `mergeFilters` may pass through). One-sided-only leaders (`twoSidedMode === 'off'`) are
 * untouched: the brick stays opt-in for them.
 */
function forceTwoSidedFilterGuards(
  filters: FilterConfig,
  twoSidedMode: TwoSidedMode,
): FilterConfig {
  if (twoSidedMode === 'off') return filters;
  return { ...filters, skipTransferFeeTokens: true };
}

/** Merge a sparse execution override (per-leader, or env bridge) onto a base execution config. */
function mergeExecution(base: ExecutionConfig, ov?: Partial<ExecutionConfig>): ExecutionConfig {
  return ov ? { ...base, ...ov } : base;
}

/** Merge a sparse priority-fee override (per-leader, or env bridge) onto a base priority-fee config. */
function mergePriorityFee(
  base: PriorityFeeConfig,
  ov?: Partial<PriorityFeeConfig>,
): PriorityFeeConfig {
  return ov ? { ...base, ...ov } : base;
}

/** Merge a sparse rug-SL override (per-leader, or env bridge) onto a base rug-SL config. */
function mergeRugSl(base: RugSlConfig, ov?: Partial<RugSlConfig>): RugSlConfig {
  return ov ? { ...base, ...ov } : base;
}

/** Resolve the config for ONE leader. Unknown address ⇒ user defaults with the leader treated as STOPPED:
 *  a leader REMOVED from the list counts as stopped (SPEC §4.3) — treating it as enabled would keep copying a
 *  leader the user deleted (the start/stop model would fail OPEN). */
export function effectiveFor(cfg: CopybotConfig, address: string): EffectiveConfig {
  const user = cfg.user;
  const leader = cfg.leaders.find((l) => l.address === address);
  const ov = leader?.overrides ?? {};
  const leaderEnabled = leader?.enabled ?? false;
  const twoSidedMode = ov.twoSidedMode ?? user.twoSidedMode; // resolve once — also gates the forced two-sided filter guard
  const caps: CapsConfig = {
    ...user.caps,
    killSwitchGlobal: user.caps.killSwitchGlobal || !user.enabled, // master switch off ⇒ no opens
    killSwitchLeader: user.caps.killSwitchLeader || !leaderEnabled, // per-leader pause
  };
  return {
    sizing: mergeSizing(user.sizing, ov.sizing),
    twoSidedMode,
    filters: forceTwoSidedFilterGuards(mergeFilters(user.filters, ov.filters), twoSidedMode),
    execution: mergeExecution(user.execution, ov.execution),
    priorityFee: mergePriorityFee(user.priorityFee, ov.priorityFee),
    rugSl: mergeRugSl(user.rugSl, ov.rugSl),
    infiniteAdd: ov.infiniteAdd ?? user.infiniteAdd,
    claimFloorSol: ov.claimFloorSol ?? user.claimFloorSol,
    caps,
    userEnabled: user.enabled,
    leaderEnabled,
    leaderMaxTotalExposureSol: leader?.maxTotalExposureSol ?? null,
  };
}
