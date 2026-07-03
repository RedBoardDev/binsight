/**
 * Copy-bot · Inc.4 — landing (sending the signed tx). Helius fast path: `sendRawTransaction` skipPreflight
 * + bounded re-broadcast (the configured RPC IS Helius). The dedicated Sender endpoint + Jito bundles (anti-sandwich)
 * = a config-driven improvement (HELIUS_SENDER_URL / JITO) — the copy mechanics do not depend on them.
 */
import type { Connection } from '@solana/web3.js';

export async function land(conn: Connection, rawSignedTx: Buffer | Uint8Array): Promise<string> {
  return conn.sendRawTransaction(rawSignedTx, { skipPreflight: true, maxRetries: 3 });
}
