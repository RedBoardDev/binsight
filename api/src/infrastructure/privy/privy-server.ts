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

  /** Look up a wallet by its Privy id — used at provisioning to confirm the wallet, and later to read its signers. */
  async getWallet(walletId: string): Promise<PrivyWalletRef> {
    const w = await this.client.wallets().get(walletId);
    return { walletId: w.id, address: w.address };
  }

  /**
   * Look up a wallet by its on-chain address → its Privy wallet id (the id the coffre signs by). VERIFIED against
   * @privy-io/node 0.24.0 (`client.wallets().getWalletByAddress({ address })` → Wallet with `id` + `address`). This
   * is the primary provisioning path: the web wizard reports the user's embedded-wallet address and the server
   * resolves the id from it.
   */
  async getWalletByAddress(address: string): Promise<PrivyWalletRef> {
    const w = await this.client.wallets().getWalletByAddress({ address });
    return { walletId: w.id, address: w.address };
  }

  /**
   * Resolve the account's Privy embedded Solana wallet (id + address) at provisioning.
   *  - With a client-reported `address` → `getWalletByAddress` (VERIFIED, exercised path).
   *  - DID-only → the exact user-by-DID retrieval + Solana-embedded-wallet selection is finalized on the devnet
   *    run (§2.5.3); 0.24.0's typed public surface exposes user lookup by linked identifiers but not a plain
   *    get-by-DID, and PRIVY_SIGNING_ENABLED is OFF so this path is never hit until then.
   */
  async resolveEmbeddedWallet(input: { did: string; address?: string }): Promise<PrivyWalletRef> {
    if (input.address) return this.getWalletByAddress(input.address);
    // TODO(devnet-4f): finalize the get-user-by-DID → Solana embedded-wallet id/address lookup against the live API.
    throw new PrivyProvisioningUnavailableError(input.did);
  }
}

/** A resolved Privy wallet reference — the id the coffre signs by + its on-chain address. */
export interface PrivyWalletRef {
  walletId: string;
  address: string;
}

/**
 * The DID-only embedded-wallet lookup isn't wired against the live Privy API until devnet 4f; a caller reaching it
 * (only possible with the flag ON and no client-reported address) surfaces this typed error instead of a silent
 * mis-provision. The wizard always supplies the address, so the exercised path never throws.
 */
export class PrivyProvisioningUnavailableError extends Error {
  constructor(readonly did: string) {
    super(`Privy embedded-wallet lookup by DID is not wired until devnet 4f (did=${did})`);
    this.name = 'PrivyProvisioningUnavailableError';
  }
}
