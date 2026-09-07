/**
 * Copy-bot · Inc.4b — WALL A (PURE). Builds the per-user Privy policy document attached to the coffre's session
 * signer at activation. Privy enforces this INSIDE its TEE at sign time, so a compromised brain/coffre process can
 * never make the wallet sign an out-of-policy tx (defense in depth). Wall B (`coffre/wall-b.ts`) stays AUTHORITATIVE
 * — it re-decodes the unsigned tx before we hand it to Privy — and Wall A mirrors its allowlist exactly (both import
 * the program IDs from `program-ids.ts`, the single source, so they can't drift).
 *
 * The security model is DEFAULT-DENY, per instruction:
 *  - ALLOW the copy programs (DLMM, Jupiter v6, ComputeBudget, Token, Token-2022, ATA). None of these move SOL to a
 *    foreign address; a `SystemProgram.transfer` is deliberately NOT covered here.
 *  - ALLOW `System.Transfer` ONLY to the user's own destinations (their wallet + their WSOL/token ATAs) ∪ the 8
 *    canonical Jito tip accounts ∪ the operator fee sink — and only up to a per-transfer lamport cap. The System
 *    program is intentionally NOT blanket-allowed (stricter than Wall B): the sole SOL-moving instruction is bound
 *    to a known destination set, so no foreign outflow can ever match an ALLOW rule.
 *  - Everything else falls through to DENY.
 *
 * NOTE (field names finalized on devnet §2.5.3): the condition field identifiers below match Privy Node 0.24.0's
 * typed Solana policy conditions (`programId` / `Transfer.to` / `Transfer.lamports`, with `solana_program_instruction`
 * / `solana_system_program_instruction` field sources). The exact default-deny semantics (implicit vs. the explicit
 * trailing DENY rule we emit) and the lamport value encoding are re-confirmed against the live TEE before the flag
 * flips; `policy-admin.ts` maps this pure doc onto the SDK's `PolicyCreateParams` there.
 */
import { JITO_TIP_ACCOUNTS } from './jito-tip';
import {
  ATA_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  DLMM_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './program-ids';

/** The programs Wall A allows the bot to invoke. System is handled separately (constrained Transfer rule only). */
export const WALL_A_ALLOWED_PROGRAMS: readonly string[] = [
  DLMM_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ATA_PROGRAM_ID,
];

/** Rule names — stable identifiers (functional keys, never "translated"); the tests + the devnet audit key off them. */
export const WALL_A_RULE_ALLOW_PROGRAMS = 'allow-copy-programs';
export const WALL_A_RULE_ALLOW_TRANSFERS = 'allow-system-transfer-to-own-set';
export const WALL_A_RULE_DEFAULT_DENY = 'default-deny';

/** The one Privy method a coffre session signer ever calls (legacy web3.js sign path — see `signer.ts`). */
export const WALL_A_SIGN_METHOD = 'signTransaction';

/** One condition on a policy rule (our neutral shape; `policy-admin.ts` maps it to the SDK's snake_case fields). */
export interface WallAPolicyCondition {
  field: 'programId' | 'Transfer.to' | 'Transfer.lamports';
  fieldSource: 'solana_program_instruction' | 'solana_system_program_instruction';
  operator: 'in' | 'lte';
  value: string | string[];
}

/** One policy rule (all rules target the sign method; the action + conditions decide ALLOW vs DENY). */
export interface WallAPolicyRule {
  name: string;
  method: typeof WALL_A_SIGN_METHOD;
  action: 'ALLOW' | 'DENY';
  conditions: WallAPolicyCondition[];
}

/** The pure policy document (`policy-admin.ts` turns this into a Privy `POST /v1/policies` create). */
export interface WallAPolicyDoc {
  version: '1.0';
  chainType: 'solana';
  /** Explicit statement that a non-matching instruction is denied (mirrors Privy's allowlist default; also emitted
   *  as the trailing DENY rule so the deny is inspectable, not merely implicit). */
  defaultAction: 'DENY';
  rules: WallAPolicyRule[];
}

export interface WallAPolicyInput {
  /** The user's own wallet (the tx owner / feePayer) — a permitted System.Transfer destination (rare, but own-funds). */
  userWallet: string;
  /** The user's OWN token accounts a legitimate tx wraps SOL into (their WSOL ATA, residual token ATAs). */
  userOwnedDestinations: string[];
  /** The 5%-fee sink — the ONE non-own, non-tip destination (kind:'fee' outflow; Wall B gates it to that kind). */
  operatorFeeAddress: string;
  /** Hard ceiling on a single System.Transfer's lamports (defense in depth against an inflated wrap/tip/fee). */
  maxTransferLamports: number;
}

/** Deduplicate + sort a destination list so the emitted policy is deterministic (stable across re-provisioning). */
function normalizeDestinations(addresses: string[]): string[] {
  return [...new Set(addresses)].sort();
}

/**
 * Build the per-user Wall A policy document. Pure: same input ⇒ byte-identical output (so re-provisioning is a
 * no-op / diffable). The allowed System.Transfer destinations are EXACTLY {userWallet ∪ userOwnedDestinations ∪ the
 * 8 Jito tips ∪ operatorFeeAddress} — no foreign address can appear. Callers must pass their real ATAs; anything
 * omitted simply can't receive SOL (fail-closed).
 */
export function buildWallAPolicy(input: WallAPolicyInput): WallAPolicyDoc {
  const transferDestinations = normalizeDestinations([
    input.userWallet,
    ...input.userOwnedDestinations,
    ...JITO_TIP_ACCOUNTS.map((a) => a.toBase58()),
    input.operatorFeeAddress,
  ]);
  return {
    version: '1.0',
    chainType: 'solana',
    defaultAction: 'DENY',
    rules: [
      {
        name: WALL_A_RULE_ALLOW_PROGRAMS,
        method: WALL_A_SIGN_METHOD,
        action: 'ALLOW',
        conditions: [
          {
            field: 'programId',
            fieldSource: 'solana_program_instruction',
            operator: 'in',
            value: [...WALL_A_ALLOWED_PROGRAMS],
          },
        ],
      },
      {
        name: WALL_A_RULE_ALLOW_TRANSFERS,
        method: WALL_A_SIGN_METHOD,
        action: 'ALLOW',
        conditions: [
          {
            field: 'Transfer.to',
            fieldSource: 'solana_system_program_instruction',
            operator: 'in',
            value: transferDestinations,
          },
          {
            // lamports as a decimal string — a u64 can exceed JS's safe integer range; the cap is well within it,
            // but the wire encoding is a string to match Privy's `ConditionValue` (string | string[]).
            field: 'Transfer.lamports',
            fieldSource: 'solana_system_program_instruction',
            operator: 'lte',
            value: String(Math.floor(input.maxTransferLamports)),
          },
        ],
      },
      {
        name: WALL_A_RULE_DEFAULT_DENY,
        method: WALL_A_SIGN_METHOD,
        action: 'DENY',
        conditions: [],
      },
    ],
  };
}
