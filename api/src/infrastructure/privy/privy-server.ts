/**
 * Copy-bot · infrastructure (Inc.4a) — thin typed facade over the Privy Node SDK (`@privy-io/node`) for the COFFRE's
 * signing use. The coffre calls `signTransaction(walletId, base64)`; Privy adds the wallet-OWNER signature in its TEE
 * and returns the signed tx as base64. The coffre AUTHORIZATION key (its P-256 session-signer credential) authorizes
 * the request via Privy's typed `authorization_context.authorization_private_keys` (0.24.0), and the SDK computes the
 * `privy-authorization-signature` header.
 *
 * Firewall (F1b): this module + `copybot/coffre/signer.ts` are the ONLY coffre-side importers of `@privy-io/node`.
 * Later waves extend this facade (policies, `users().delete`, `exportPrivateKey`); 4a needs only construct +
 * signTransaction. base64-in / base64-out over a LEGACY web3.js transaction — never the `@solana/kit` signer path
 * (the whole copybot is `@solana/web3.js`).
 */
import { PrivyClient } from '@privy-io/node';

export interface PrivyServerConfig {
  appId: string;
  appSecret: string;
  /**
   * Coffre session-signer P-256 private key (base64 PKCS8, no PEM headers) — the DEFAULT request-authorization key for
   * `signTransaction`. Off-host; undefined until the devnet 4f flag flip. A per-call key overrides it.
   */
  authorizationKey?: string;
}

export class PrivyServer {
  private readonly client: PrivyClient;
  private readonly authorizationKey?: string;
  constructor(cfg: PrivyServerConfig) {
    this.client = new PrivyClient({ appId: cfg.appId, appSecret: cfg.appSecret });
    this.authorizationKey = cfg.authorizationKey;
  }

  /**
   * Sign a base64-serialized (legacy web3.js) transaction with the Privy-custodied wallet `walletId`; returns the
   * signed tx as base64. `authorizationKey` overrides the facade default. `method: 'signTransaction'` is a literal so
   * the SDK narrows the response to the Solana variant → `res.data.signed_transaction` is typed.
   */
  async signTransaction(
    walletId: string,
    transactionBase64: string,
    authorizationKey?: string,
  ): Promise<string> {
    const key = authorizationKey ?? this.authorizationKey;
    const res = await this.client.wallets().rpc(walletId, {
      method: 'signTransaction' as const,
      params: { encoding: 'base64' as const, transaction: transactionBase64 },
      authorization_context: key ? { authorization_private_keys: [key] } : undefined,
    });
    return res.data.signed_transaction;
  }
}
