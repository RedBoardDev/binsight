/**
 * Copy-bot · Inc.4b — the activation SERVICE (API-side orchestration). Turns a verified Privy account into a
 * signable copy-bot custody wallet: provision (resolve the embedded wallet → create the per-user Wall A policy →
 * write the activation row + users.address/wallet_id), then drive the resumable wizard (consent → deposit → export)
 * and run the SYSTEM signing-gate reconciler that clears `signing_disabled` once the account is provably ready.
 *
 * All Privy touch points are injected as PORTS so the DB/state/gate logic is unit-tested with fakes (no live Privy).
 * This module lives in the API zone: the coffre reaches the SAME state only through the Privy-free repository (F1b).
 */
import type { Logger } from 'pino';
import {
  type ActivationState,
  MIN_ACTIVATION_LAMPORTS,
  MIN_ACTIVATION_SOL,
  signingReady,
} from '@/domain/copybot/activation';
import { deriveOwnerWsolAta } from '@/domain/copybot/ata';
import type { CopybotActivationRepository } from '@/infrastructure/persistence/copybot-activation-repository';

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Resolves an account's Privy embedded Solana wallet (id + address) at provisioning (privy-server facade). */
export interface EmbeddedWalletResolver {
  resolveEmbeddedWallet(input: { did: string; address?: string }): Promise<{
    walletId: string;
    address: string;
  }>;
}

/** Creates the per-user Wall A policy (governance-key module). Optional: absent ⇒ policyId null (Wall B is authoritative). */
export interface UserPolicyAdmin {
  createUserPolicy(input: {
    walletAddress: string;
    walletAtaAddresses: string[];
  }): Promise<{ policyId: string }>;
}

export interface CopybotActivationDeps {
  repo: CopybotActivationRepository;
  walletResolver: EmbeddedWalletResolver;
  /** Optional — when the governance key isn't configured (this wave's default), provisioning proceeds with no policy. */
  policyAdmin?: UserPolicyAdmin;
  /** Live wallet balance (lamports) provider — a short-TTL getBalance in prod, a fake in tests. */
  balances: (address: string) => Promise<number>;
  /** How many of the user's leaders are STARTED (enabled) — the third signing-ready condition (SPEC §3). */
  startedLeaderCount: (userId: string) => Promise<number>;
  log: Logger;
}

/** The activation snapshot the web wizard reads (row + live balance + the derived signing-ready verdict). */
export interface ActivationView {
  activation: ActivationState | null;
  address: string | null;
  balanceLamports: number;
  balanceSol: number;
  minActivationSol: number;
  startedLeaderCount: number;
  signingReady: boolean;
}

export class CopybotActivationService {
  constructor(private readonly deps: CopybotActivationDeps) {}

  /**
   * Provision the account (idempotent). A second call with an existing activation row is a NO-OP that returns the
   * existing view — no Privy lookup, no duplicate policy. `address` (the client-reported embedded-wallet address)
   * takes the VERIFIED getWalletByAddress path; DID-only resolution is finalized on devnet 4f.
   */
  async provision(
    userId: string,
    did: string,
    opts?: { address?: string },
  ): Promise<ActivationView> {
    const existing = await this.deps.repo.find(userId);
    if (existing) return this.viewOf(userId, existing);

    const wallet = await this.deps.walletResolver.resolveEmbeddedWallet({
      did,
      address: opts?.address,
    });
    let policyId: string | null = null;
    if (this.deps.policyAdmin) {
      const created = await this.deps.policyAdmin.createUserPolicy({
        walletAddress: wallet.address,
        walletAtaAddresses: [deriveOwnerWsolAta(wallet.address)],
      });
      policyId = created.policyId;
    } else {
      // No governance key configured this wave: proceed policy-less (Wall B stays authoritative). The policy is
      // attached later (devnet 4f). Logged so the operator knows defense-in-depth isn't in place yet.
      this.deps.log.warn(
        { userId },
        'provision: no policy admin configured → Wall A policy not created',
      );
    }
    const state = await this.deps.repo.provision({
      userId,
      privyWalletId: wallet.walletId,
      address: wallet.address,
      policyId,
    });
    return this.viewOf(userId, state);
  }

  /** The current activation view — reconciles the signing gate as a side effect (so a funded/started account clears). */
  async state(userId: string): Promise<ActivationView> {
    const row = await this.deps.repo.find(userId);
    return this.viewOf(userId, row);
  }

  /** Consent complete: the client ran addSigners → the coffre session signer is live. Advances to 'deposit'. */
  async consentComplete(userId: string): Promise<ActivationView> {
    await this.deps.repo.markConsentComplete(userId, Date.now());
    return this.state(userId);
  }

  /** Record the key-export acknowledgement (offer accepted or skipped). Advances the wizard to 'done'. */
  async exportAck(userId: string): Promise<ActivationView> {
    await this.deps.repo.markExportAck(userId, Date.now());
    return this.state(userId);
  }

  /**
   * Build the view for a (possibly null) row and run the SYSTEM signing-gate reconciler. The reconciler is ONE-WAY
   * (#132): it CLEARS `signing_disabled` once `signingReady` (signer added + funded ≥ 1 SOL + ≥ 1 started leader),
   * but NEVER re-sets it — a leader CLOSE returns funds and must always be signable, so a spent idle balance or a
   * stopped last leader can never re-gate signing (funding gates OPENs only, via the returned `signingReady`). A
   * genuine kill (revoked signer / operator) stays disabled through `signer_added=false`. Idempotent — it only writes
   * when the gate actually clears or the funded stamp is first set. Called on every read/transition; a periodic
   * brain/API reconciler can call `state(userId)` on the same cadence (documented; no separate scheduler this wave).
   */
  private async viewOf(userId: string, row: ActivationState | null): Promise<ActivationView> {
    if (!row) {
      return {
        activation: null,
        address: null,
        balanceLamports: 0,
        balanceSol: 0,
        minActivationSol: MIN_ACTIVATION_SOL,
        startedLeaderCount: 0,
        signingReady: false,
      };
    }
    const signable = await this.deps.repo.resolveSignableWallet(userId);
    const address = signable?.address ?? null;
    const balanceLamports = address ? await this.deps.balances(address) : 0;
    const startedLeaderCount = await this.deps.startedLeaderCount(userId);
    const ready = signingReady(row, balanceLamports, startedLeaderCount);
    const funded = balanceLamports >= MIN_ACTIVATION_LAMPORTS;

    // ONE-WAY signing gate (#132): the reconciler may only CLEAR `signing_disabled` once the account is provably
    // ready — it must NEVER re-set it from idle balance or started-leader count. A leader CLOSE returns funds and
    // must always be signable, so a mirror that spent the idle balance (or a stopped last leader) can never re-gate
    // signing. A genuine kill (revoked signer / operator) sets signer_added=false ⇒ `signingReady` stays false ⇒
    // `clearGate` is never true for it, so the kill is never cleared here. Funding gates OPENs only (via `signingReady`).
    const clearGate = ready && row.signingDisabled; // the only `signing_disabled` transition we persist: true → false
    const fundedStampNeeded = funded && row.fundedAt == null;
    let effectiveRow = row;
    if (clearGate || fundedStampNeeded) {
      const now = Date.now();
      await this.deps.repo.applySigningGate(userId, { clearSigningDisabled: clearGate, funded }, now);
      effectiveRow = {
        ...row,
        signingDisabled: clearGate ? false : row.signingDisabled,
        fundedAt: fundedStampNeeded ? now : row.fundedAt,
        updatedAt: now,
      };
    }
    return {
      activation: effectiveRow,
      address,
      balanceLamports,
      balanceSol: balanceLamports / LAMPORTS_PER_SOL,
      minActivationSol: MIN_ACTIVATION_SOL,
      startedLeaderCount,
      signingReady: ready,
    };
  }
}
