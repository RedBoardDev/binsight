/**
 * Copy-bot · Inc.4b — activation domain (PURE). The per-account custody lifecycle: provision the Privy wallet →
 * consent (add the coffre session signer) → deposit ≥ 1 SOL → optional key export → done. The `signing_disabled`
 * flag is the per-user kill switch the coffre reads: it starts ON and is cleared ONLY when the account is provably
 * ready to sign live. This module holds the state shape, the step machine, and the pure `signingReady` predicate —
 * no I/O — so the "when may this user sign" decision is unit-tested in isolation.
 */

/** Lamports per SOL (local per-module const — the project convention, see position-adjust.ts / priority-fee.ts). */
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Resumable wizard step (persisted as `activation_step`). Ordered: the web resumes the wizard at this step. */
export const ACTIVATION_STEPS = ['consent', 'deposit', 'export', 'done'] as const;
export type ActivationStep = (typeof ACTIVATION_STEPS)[number];

/** Minimum funded balance (SPEC §3) before an account may sign live — a floor that a fee/rent can't dip it under. */
export const MIN_ACTIVATION_SOL = 1;
export const MIN_ACTIVATION_LAMPORTS = MIN_ACTIVATION_SOL * LAMPORTS_PER_SOL;

/** The persisted activation row (one per user). Timestamps are epoch-ms (Date.now); null = not-yet. */
export interface ActivationState {
  userId: string;
  privyWalletId: string;
  policyId: string | null;
  signerAdded: boolean;
  signingDisabled: boolean;
  activationStep: ActivationStep;
  fundedAt: number | null;
  exportAckAt: number | null;
  withdrawalAckAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Whether the account may sign LIVE — the SYSTEM decision that clears `signing_disabled` (a reconciler, never the
 * user directly). All three must hold (SPEC §3):
 *  - the coffre session signer was added (consent done),
 *  - the wallet holds ≥ MIN_ACTIVATION_SOL (funded — a starved wallet would only produce failed opens), and
 *  - ≥ 1 leader is STARTED (nothing to copy otherwise; keeps a funded-but-idle account non-signable).
 * Pure: the caller supplies the live balance + started-leader count.
 */
export function signingReady(
  activation: Pick<ActivationState, 'signerAdded'>,
  balanceLamports: number,
  startedLeaderCount: number,
): boolean {
  return (
    activation.signerAdded && balanceLamports >= MIN_ACTIVATION_LAMPORTS && startedLeaderCount >= 1
  );
}
