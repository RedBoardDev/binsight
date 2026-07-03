import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { isValidSolanaAddress } from './solana-address';

describe('isValidSolanaAddress — the wallet-input gate', () => {
  // Rejecting junk BEFORE it burns a watch slot + an RPC backfill is the point of this validator:
  // downstream (engine, DELETE paths) only ever sees real base58 32-byte pubkeys.
  it('validates real Solana addresses and rejects malformed ones', () => {
    const real = Keypair.generate().publicKey.toBase58();
    expect(isValidSolanaAddress(real)).toBe(true);
    expect(isValidSolanaAddress('not-an-address')).toBe(false);
    expect(isValidSolanaAddress('0OIl')).toBe(false); // contains base58-excluded chars + too short
    expect(isValidSolanaAddress('')).toBe(false);
    expect(isValidSolanaAddress(null)).toBe(false);
    expect(isValidSolanaAddress(123)).toBe(false);
  });
});
