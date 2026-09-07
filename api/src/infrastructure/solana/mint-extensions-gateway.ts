/**
 * Copy-bot · I/O adapter — reads a mint's Token-2022 extension set to answer "does it carry a `TransferFeeConfig`?"
 * ONE `getMint` against the Token-2022 program → `getTransferFeeConfig` presence. Best-effort like the Jupiter /
 * price gateways (never throws on the open path). The safety hinge (finding #105): a CONFIRMED non-Token-2022
 * owner ⇒ `false` (a classic-SPL mint cannot carry the extension — the common case that keeps the filter
 * FUNCTIONAL), a confirmed Token-2022 read ⇒ `true`/`false` by presence, and ANY unreadable case (missing /
 * malformed / RPC error / timeout / bad address) ⇒ `null` so the enabled brick fails CLOSED rather than letting a
 * fee'd mint slip through the two-sided deposit haircut. Backs the `mint-extensions` filter source (spec `19` §5).
 */
import {
  getMint,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { type Commitment, type Connection, PublicKey } from '@solana/web3.js';
import type { MintExtensionsProvider } from '@/domain/copybot/filters/sources/source';

const DEFAULT_COMMITMENT: Commitment = 'confirmed'; // mint-account read level (matches the brain's Connection)

export interface MintExtensionsGatewayOpts {
  commitment?: Commitment;
  /** Called on any UNREADABLE outcome (→ `null`) so the brain can log/record health, decoupled from this adapter. */
  onError?: (err: unknown, mint: string) => void;
}

export class MintExtensionsGateway {
  private readonly commitment: Commitment;

  constructor(
    private readonly conn: Connection,
    private readonly opts: MintExtensionsGatewayOpts = {},
  ) {
    this.commitment = opts.commitment ?? DEFAULT_COMMITMENT;
  }

  /** A `MintExtensionsProvider` — bind as `(m) => gateway.hasTransferFee(m)`. */
  readonly hasTransferFee: MintExtensionsProvider = async (mint) => {
    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(mint);
    } catch (err) {
      // A malformed mint address is confirmed-unreadable input — never "fee-free": fail closed.
      this.opts.onError?.(err, mint);
      return null;
    }
    try {
      const info = await getMint(this.conn, mintPk, this.commitment, TOKEN_2022_PROGRAM_ID);
      return getTransferFeeConfig(info) !== null;
    } catch (err) {
      // CONFIRMED non-Token-2022 owner (classic SPL / any other program) ⇒ it cannot carry a Token-2022
      // `TransferFeeConfig` ⇒ definitively fee-free. Safe `false`, and the common case (most mints are classic
      // SPL) — this is what makes the filter FUNCTIONAL instead of fail-closed on every open.
      if (err instanceof TokenInvalidAccountOwnerError) return false;
      // Anything else — account missing/oversized, RPC/network/timeout — is UNREADABLE: `null` so the resolver
      // leaves `hasTransferFee` unresolved and the brick fails closed (finding #105).
      this.opts.onError?.(err, mint);
      return null;
    }
  };
}
