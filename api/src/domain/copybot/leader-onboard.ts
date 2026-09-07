/**
 * Copy-bot · Inc.4b — leader onboarding (PURE). The deterministic side of adding a leader to a user's config: the
 * reject reasons for a pasted address, and the config transform that inserts a wizard-configured leader STOPPED.
 * The one non-deterministic check (on-chain DLMM activity) is layered on in the application service; keeping the
 * rest pure lets the reject matrix + the config write be unit-tested without a DB or an RPC.
 */
import { isValidSolanaAddress } from '@/util/solana-address';
import { addLeader } from './config/edit';
import type { CopybotConfig, TwoSidedMode } from './config/types';

/** Why a pasted leader address is rejected (stable functional codes — the web renders a precise message per code). */
export const LEADER_REJECT_REASONS = [
  'invalid_address',
  'own_wallet',
  'duplicate',
  'no_dlmm_activity',
] as const;
export type LeaderRejectReason = (typeof LEADER_REJECT_REASONS)[number];

/**
 * The DETERMINISTIC reject reason for a candidate address, or null if it passes the deterministic checks (the
 * caller then runs the on-chain DLMM-activity check). Rejects: a malformed address, the user's OWN bot wallet (a
 * self-copy loop), and a leader already configured (a duplicate mirror). Pure.
 */
export function leaderRejectReason(input: {
  address: string;
  ownAddress: string | null;
  existingAddresses: string[];
}): LeaderRejectReason | null {
  if (!isValidSolanaAddress(input.address)) return 'invalid_address';
  if (input.ownAddress && input.address === input.ownAddress) return 'own_wallet';
  if (input.existingAddresses.includes(input.address)) return 'duplicate';
  return null;
}

/** The wizard-configured fields for a NEW leader (created STOPPED — never copies before the user presses Start). */
export interface NewLeaderInput {
  address: string;
  /** Hard cap on a single copied trade's size (SOL). Pre-filled 1. */
  maxTradeSizeSol: number;
  /** % of the leader's size to mirror. Pre-filled 100; >100 allowed (amplify); never null from the wizard. */
  tradeRatioPct: number;
  /** Total SOL exposure ceiling across THIS leader's mirrors. null = no per-leader cap. */
  maxTotalExposureSol: number | null;
  /** Copy the leader's two-legged (token+SOL) positions, or only the SOL leg. */
  twoSidedMode: TwoSidedMode;
}

/**
 * Insert a wizard-configured leader into the config, STOPPED, with its sizing/exposure/two-sided overrides applied.
 * Reuses `addLeader` (throws on a duplicate — the deterministic guard the service re-checks). Pure (returns a new
 * config); the caller validates against the schema before persisting.
 */
export function applyNewLeaderConfig(config: CopybotConfig, input: NewLeaderInput): CopybotConfig {
  const withLeader = addLeader(config, input.address); // appends { enabled:false, maxTotalExposureSol:null, overrides:{} }
  return {
    ...withLeader,
    leaders: withLeader.leaders.map((l) =>
      l.address === input.address
        ? {
            ...l,
            maxTotalExposureSol: input.maxTotalExposureSol,
            overrides: {
              ...l.overrides,
              sizing: {
                ...l.overrides.sizing,
                maxTradeSizeSol: input.maxTradeSizeSol,
                tradeRatioPct: input.tradeRatioPct,
              },
              twoSidedMode: input.twoSidedMode,
            },
          }
        : l,
    ),
  };
}
