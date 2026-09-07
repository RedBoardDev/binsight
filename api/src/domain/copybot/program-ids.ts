/**
 * Copy-bot · the canonical Solana program IDs the bot's txs may touch — the SINGLE SOURCE shared by BOTH firewalls:
 * Wall B (`coffre/wall-b.ts`, the authoritative unsigned-tx re-decode) and Wall A (`wall-a-policy.ts`, the per-user
 * Privy policy = defense in depth). Keeping ONE list here is what lets a test prove Wall A mirrors Wall B's allowlist
 * instead of the two drifting apart. DLMM / SOL / classic-Token come from `@binsight/shared` (already canonical);
 * the copy-bot-specific ones (System, Token-2022, ATA, ComputeBudget, Jupiter v6) live here.
 *
 * Pure string constants + `@solana/web3.js` only (no DLMM SDK) — safe to import from the coffre (firewall F3).
 */
import { DLMM_PROGRAM_ID, SOL_MINT, TOKEN_PROGRAM_ID } from '@binsight/shared';

export { DLMM_PROGRAM_ID, SOL_MINT, TOKEN_PROGRAM_ID };

/** System program — SOL transfers (wrap-to-WSOL / Jito tip / fee) + account creation are its instructions. */
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
/** Token-2022 — a residual leg is often a Token-2022 mint (pump.fun-style), so its ATA/ops must be allowed. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Associated Token Account program — the WSOL/residual ATAs are created/closed through it. */
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** ComputeBudget — the priority-fee (CU price/limit) instructions; bounded, never a foreign-SOL vector. */
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
/** Jupiter v6 — the residual token→SOL re-swap (and the two-sided SOL→token buy). */
export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
