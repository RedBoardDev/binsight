import { z } from 'zod';
import { Base58Address } from './address';

/* ────────────────────────────────────────────────────────────────────────
 * Wallets
 * ──────────────────────────────────────────────────────────────────────── */

export const WalletSchema = z.object({
  address: Base58Address,
  label: z.string().max(64).default(''),
  color: z.string().max(32).optional(),
  createdAt: z.number().int(),
  /** onboarding status (server-enriched): false while the wallet's history is still being indexed
   *  (a brand-new wallet's backfill). Absent on write payloads. */
  ready: z.boolean().optional(),
  /** txs ingested so far during the initial backfill — for an "indexing… (N txs)" UI state. */
  indexedTxs: z.number().int().optional(),
});
export type Wallet = z.infer<typeof WalletSchema>;
