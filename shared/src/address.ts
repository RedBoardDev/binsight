import { z } from 'zod';

/** A Solana address in the base58 alphabet (no 0/O/I/l), 32–44 chars. Defence-in-depth at the wire
 *  edge: the write path already calls isValidSolanaAddress, but the schemas accepted arbitrary chars. */
export const Base58Address = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'must be a base58 Solana address');
