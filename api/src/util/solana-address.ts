import { PublicKey } from '@solana/web3.js';

/** True iff `address` is a syntactically valid Solana address (base58 that decodes to 32 bytes). */
export function isValidSolanaAddress(address: unknown): address is string {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) return false;
  try {
    return new PublicKey(address).toBytes().length === 32;
  } catch {
    return false;
  }
}
