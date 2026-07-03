/**
 * Copy-bot · pure Associated-Token-Account derivation (no `spl-token`, no I/O). The ATA seed differs by token
 * program (classic SPL vs Token-2022), yielding distinct addresses for the same (owner, mint). Wall A uses this to
 * enumerate the user's OWN token accounts (their WSOL ATA) as permitted `System.Transfer` destinations — the same
 * derivation Wall B applies when it binds a wrap/swap to `owner`'s ATA.
 */
import { PublicKey } from '@solana/web3.js';
import { ATA_PROGRAM_ID, SOL_MINT, TOKEN_PROGRAM_ID } from './program-ids';

const ATA_PROGRAM = new PublicKey(ATA_PROGRAM_ID);

/** Owner's ATA for `mint` under `tokenProgram` (base58). Pure — a fixed on-chain PDA algorithm. */
export function deriveOwnerAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): string {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0].toBase58();
}

/** Owner's wrapped-SOL (WSOL) ATA under the classic SPL Token program — where a deposit/swap wraps SOL. */
export function deriveOwnerWsolAta(owner: string): string {
  return deriveOwnerAta(
    new PublicKey(owner),
    new PublicKey(SOL_MINT),
    new PublicKey(TOKEN_PROGRAM_ID),
  );
}
