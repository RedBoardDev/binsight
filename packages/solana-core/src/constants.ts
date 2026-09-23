/** Solana and Meteora DLMM constants. */

/** 1 SOL in lamports. */
export const LAMPORTS_PER_SOL = 1e9;

export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Official Token Extensions / Token-2022 program. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Stablecoins counted in the idle wallet balance (USD), converted to SOL via Jupiter. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** PositionV2 Anchor account: discriminator (8) + lb_pair (32) + owner (32) — owner is thus at byte 40
 *  (see POSITION_V2_OWNER_OFFSET in dlmm/layout, where the memcmp filter that uses it lives). */
export const POSITION_V2_DISCRIMINATOR = [117, 176, 212, 199, 245, 180, 133, 182] as const;
