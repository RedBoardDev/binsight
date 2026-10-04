import { z } from 'zod';

// Which wallets a page shows: all of them, or one, by its address (base58, 32 to 44 characters).
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const ALL_WALLETS = 'all';

export const walletScopeSchema = z.union([
  z.literal(ALL_WALLETS),
  z.string().regex(SOLANA_ADDRESS),
]);

export type WalletScope = z.infer<typeof walletScopeSchema>;
