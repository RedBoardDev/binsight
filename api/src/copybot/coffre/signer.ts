/**
 * Copy-bot · coffre (Inc.4a) — the Signer PORT + its implementations. The critical section (process-command.ts) no
 * longer holds a raw `Keypair`; it holds a `Signer` resolved per SIGNED tenant. This single seam lets the SAME
 * pipeline drive:
 *  - the SYSTEM/bench wallet with a LOCAL keypair — byte-identical to the pre-Inc.4 inline path (the on-chain bench
 *    depends on it), and
 *  - a per-user Privy-custodied wallet — the OWNER signature comes from Privy's TEE while WE still broadcast, so the
 *    exactly-once landing protocol in process-command is untouched — behind `PRIVY_SIGNING_ENABLED` (default OFF).
 *
 * Firewall (F1b): this module + `infrastructure/privy/privy-server.ts` are the ONLY coffre-side importers of the
 * signing authority (`@privy-io/node`); the brain can never name them.
 */
import { utils } from '@coral-xyz/anchor';
import { APIConnectionError, APIError } from '@privy-io/node';
import { type Keypair, PublicKey, Transaction } from '@solana/web3.js';
import type { Logger } from 'pino';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Shared bs58 encoder — the SAME `utils.bytes.bs58` the coffre used inline for a tx signature (keep one source). */
export const bs58 = (bytes: Buffer | Uint8Array): string =>
  utils.bytes.bs58.encode(Buffer.from(bytes));

/**
 * The signing PORT. `sign` receives a tx whose `feePayer` + `recentBlockhash` are ALREADY fixed by the caller (they
 * define the message that BOTH the owner and any co-signer sign) and returns the wire bytes + the owner signature
 * (bs58) — the exactly-once pin process-command persists BEFORE broadcast. An implementation MUST NOT broadcast (WE
 * broadcast) and MUST NOT mutate any instance state.
 */
export interface Signer {
  readonly publicKey: PublicKey; // the wallet this signer signs for (the tx feePayer / owner)
  sign(tx: Transaction, coSigners: Keypair[]): Promise<{ raw: Buffer; signature: string }>;
}

/**
 * LOCAL keypair signer — the SYSTEM/bench path. Byte-identical to the pre-Inc.4 inline sequence
 * `fresh.sign(copier, ...co); raw = fresh.serialize(); sig = bs58(fresh.signature)`.
 */
export class LocalKeypairSigner implements Signer {
  readonly publicKey: PublicKey;
  constructor(private readonly keypair: Keypair) {
    this.publicKey = keypair.publicKey;
  }
  async sign(tx: Transaction, coSigners: Keypair[]): Promise<{ raw: Buffer; signature: string }> {
    tx.sign(this.keypair, ...coSigners); // owner + co-signers over the caller-frozen message
    return { raw: tx.serialize(), signature: bs58(tx.signature as Buffer) };
  }
}

/** The minimal Privy signing surface the coffre needs (implemented by `infrastructure/privy/privy-server.ts`). */
export interface TransactionSigningBackend {
  /** base64 unsigned/partially-signed tx → base64 tx with the wallet-owner signature added (Privy TEE). */
  signTransaction(
    walletId: string,
    transactionBase64: string,
    authorizationKey?: string,
  ): Promise<string>;
}

/**
 * A persistent Privy signing failure (429/5xx/timeout beyond the bounded retries). Typed for wave 4e's outage
 * classifier (#20): a repeated outage → pinned "signing unavailable" alert + skip THAT user, never a global stop.
 */
export class PrivyOutageError extends Error {
  constructor(
    readonly walletId: string,
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`Privy signing unavailable for wallet ${walletId} after ${attempts} attempts`);
    this.name = 'PrivyOutageError';
  }
}

const MAX_SIGN_RETRIES = 3; // bounded retries on a TRANSIENT Privy failure before declaring an outage (ULTRACODE #22)
const SIGN_RETRY_BASE_DELAY_MS = 250; // exponential backoff base (250→500→1000ms): sub-second so a live sign is not stalled

/**
 * A TRANSIENT Privy failure worth a bounded retry: a rate-limit (429), a server-side 5xx, or a network/timeout
 * (`APIConnectionError`, whose `.status` is undefined). A 4xx client error (bad request / permission / auth) is
 * deterministic and must surface IMMEDIATELY, never masked behind retries. Duck-types `.status` so a plain test-double
 * error exercises the SAME classification without constructing a full SDK error.
 */
export function isRetryablePrivyError(e: unknown): boolean {
  if (e instanceof APIConnectionError) return true;
  const status = e instanceof APIError ? e.status : (e as { status?: unknown } | null)?.status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * Privy session signer (per user). `feePayer` (owner) + `recentBlockhash` are fixed by the caller. We (1) partial-sign
 * the ephemeral co-signer(s) LOCALLY, (2) hand the base64 tx to Privy which adds the OWNER signature in its TEE, (3)
 * decode the fully-signed tx. `signed.signature` = the owner signature = the exactly-once pin. Bounded backoff on a
 * transient failure. NEVER broadcasts; NEVER mutates instance state.
 *
 * Off-chain-provable: the partial-sign COMPOSITION (Privy preserves the co-signer sig over the frozen message) — the
 * one fact devnet 4f confirms on real hardware (SPEC §2.5).
 */
export class PrivySessionSigner implements Signer {
  readonly publicKey: PublicKey;
  constructor(
    private readonly privy: TransactionSigningBackend,
    private readonly walletId: string,
    address: string,
    private readonly authorizationKey?: string,
  ) {
    this.publicKey = new PublicKey(address);
  }
  async sign(tx: Transaction, coSigners: Keypair[]): Promise<{ raw: Buffer; signature: string }> {
    // The ephemeral position key signs the caller-frozen message LOCALLY; Privy adds the owner (feePayer) signature
    // over the SAME message. Order-independent once feePayer+blockhash are fixed (the message is frozen).
    if (coSigners.length > 0) tx.partialSign(...coSigners);
    const partiallySigned = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
    const signedBase64 = await this.signWithBackoff(partiallySigned);
    const signed = Transaction.from(Buffer.from(signedBase64, 'base64')); // owner sig added + co-signer sig preserved
    return { raw: signed.serialize(), signature: bs58(signed.signature as Buffer) };
  }
  private async signWithBackoff(transactionBase64: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_SIGN_RETRIES; attempt++) {
      try {
        return await this.privy.signTransaction(
          this.walletId,
          transactionBase64,
          this.authorizationKey,
        );
      } catch (e) {
        if (!isRetryablePrivyError(e)) throw e; // deterministic reject → surface now (it is not an outage)
        lastError = e;
        if (attempt < MAX_SIGN_RETRIES) await sleep(SIGN_RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
    throw new PrivyOutageError(this.walletId, MAX_SIGN_RETRIES + 1, lastError);
  }
}

/**
 * The sentinel a `DryRunSigner` throws instead of signing: the caller (process-command) finalizes a BENIGN 'skipped'
 * (not a failure, not poison) so a real user's pipeline runs end-to-end while the live flag is OFF.
 */
export class DryRunSkip extends Error {
  constructor(readonly publicKey: PublicKey) {
    super('dry-run: live signing is OFF for this user — command skipped, not signed');
    this.name = 'DryRunSkip';
  }
}

/**
 * Dry-run signer for a real (Privy) user while `PRIVY_SIGNING_ENABLED` is OFF: it exposes the user's REAL publicKey
 * (so the Wall B owner check stays meaningful) but declines to sign — throwing `DryRunSkip`, which the caller turns
 * into a benign 'skipped'. This is how the pipeline runs end-to-end for a real user without ever signing.
 */
export class DryRunSigner implements Signer {
  constructor(
    readonly publicKey: PublicKey,
    private readonly log: Logger,
  ) {}
  async sign(): Promise<{ raw: Buffer; signature: string }> {
    this.log.info(
      { owner: this.publicKey.toBase58() },
      '✍️  (dry-run) live signing OFF for this user — skipping',
    );
    throw new DryRunSkip(this.publicKey);
  }
}
