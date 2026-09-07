/** Base58 as Solana uses it: no 0, O, I or l, and an address is 32–44 of those characters. */
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Shape-only check — it cannot tell whether the account exists on chain, only that the string
 *  could be an address, so the server stays the authority on what it accepts. */
export function isSolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS_RE.test(value);
}
