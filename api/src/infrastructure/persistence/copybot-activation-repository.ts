/**
 * Copy-bot · Inc.4b — persistence for the `copybot_activation` table + the `users` address/wallet-id it fills at
 * provisioning. Deliberately a thin, Privy-FREE data layer: it is imported by BOTH the API activation service AND
 * the coffre's `resolveUserWallet` (so a provisioned+ready user becomes signable), and the coffre must never pull in
 * the Privy signing authority through it (firewall F1b). All orchestration (Privy lookup, policy creation, the
 * signing-gate decision) lives in `application/copybot-activation.ts`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { ActivationState, ActivationStep } from '@/domain/copybot/activation';
import type { Database } from './database';
import { copybotActivation, users as usersTable } from './schema';

/** The (walletId, address, signingDisabled) triple the coffre needs to route a signed tenant to its wallet. */
export interface SignableWallet {
  walletId: string;
  address: string;
  signingDisabled: boolean;
}

/** The fields set when a user's Privy wallet is provisioned (the activation row is created together with them). */
export interface ProvisionInsert {
  userId: string;
  privyWalletId: string;
  address: string;
  policyId: string | null;
}

function toState(r: typeof copybotActivation.$inferSelect): ActivationState {
  return {
    userId: r.userId,
    privyWalletId: r.privyWalletId ?? '',
    policyId: r.policyId,
    signerAdded: r.signerAdded,
    signingDisabled: r.signingDisabled,
    activationStep: r.activationStep as ActivationStep,
    fundedAt: r.fundedAt,
    exportAckAt: r.exportAckAt,
    withdrawalAckAt: r.withdrawalAckAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class CopybotActivationRepository {
  constructor(private readonly db: Database) {}

  /** The activation row for a user, or null if never provisioned. */
  async find(userId: string): Promise<ActivationState | null> {
    const [r] = await this.db
      .select()
      .from(copybotActivation)
      .where(eq(copybotActivation.userId, userId))
      .limit(1);
    return r ? toState(r) : null;
  }

  /**
   * The signable-wallet triple for the coffre, or null when the user is not signable (no activation row, or the
   * wallet id / address wasn't filled). Reads the wallet id from the activation row and the address from `users`
   * (both are written together at provisioning), so a half-provisioned user resolves to null (fail-closed).
   */
  async resolveSignableWallet(userId: string): Promise<SignableWallet | null> {
    const [r] = await this.db
      .select({
        walletId: copybotActivation.privyWalletId,
        signingDisabled: copybotActivation.signingDisabled,
        address: usersTable.address,
      })
      .from(copybotActivation)
      .innerJoin(usersTable, eq(usersTable.id, copybotActivation.userId))
      .where(eq(copybotActivation.userId, userId))
      .limit(1);
    if (!r || !r.walletId || !r.address) return null;
    return { walletId: r.walletId, address: r.address, signingDisabled: r.signingDisabled };
  }

  /**
   * Create the activation row (step 'consent', signing disabled) AND fill `users.address` + `users.privy_wallet_id`,
   * atomically. Idempotent: a second call with an existing row is a no-op (the caller detects the existing row and
   * returns it) — so `provision` can be retried safely. Returns the created/existing state.
   */
  async provision(p: ProvisionInsert): Promise<ActivationState> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(copybotActivation)
        .where(eq(copybotActivation.userId, p.userId))
        .limit(1);
      if (existing[0]) return toState(existing[0]);
      const now = Date.now();
      const [row] = await tx
        .insert(copybotActivation)
        .values({
          userId: p.userId,
          privyWalletId: p.privyWalletId,
          policyId: p.policyId,
          signerAdded: false,
          signingDisabled: true,
          activationStep: 'consent',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx
        .update(usersTable)
        .set({ address: p.address, privyWalletId: p.privyWalletId })
        .where(eq(usersTable.id, p.userId));
      return toState(row as typeof copybotActivation.$inferSelect);
    });
  }

  /** Mark the coffre session signer added (consent complete) and advance the wizard to 'deposit'. */
  async markConsentComplete(userId: string, now: number): Promise<void> {
    await this.db
      .update(copybotActivation)
      .set({ signerAdded: true, activationStep: 'deposit', updatedAt: now })
      .where(eq(copybotActivation.userId, userId));
  }

  /** Record the key-export acknowledgement and advance the wizard to 'done'. */
  async markExportAck(userId: string, now: number): Promise<void> {
    await this.db
      .update(copybotActivation)
      .set({ exportAckAt: now, activationStep: 'done', updatedAt: now })
      .where(eq(copybotActivation.userId, userId));
  }

  /** Record a completed withdrawal (Path B, Inc.4e) — this stamps the teardown gate (SPEC §2.4: a completed
   *  withdrawal lets the account be deleted even with a non-dust balance). */
  async markWithdrawalAck(userId: string, now: number): Promise<void> {
    await this.db
      .update(copybotActivation)
      .set({ withdrawalAckAt: now, updatedAt: now })
      .where(eq(copybotActivation.userId, userId));
  }

  /**
   * Apply the REVOKED-delegation state (Inc.4e / #21): the user removed the coffre session signer, so signing is
   * disabled AND consent is no longer valid. Setting `signer_added=false` makes the disable STICKY — the SYSTEM
   * signing-gate reconciler (`signingReady`) can no longer auto-clear it, so re-activation requires the user to
   * re-consent (re-run addSigners). The user's open mirrors are KEPT elsewhere (never-miss: the reconcile keeps
   * trying to close them once signing returns).
   */
  async markSigningRevoked(userId: string, now: number): Promise<void> {
    await this.db
      .update(copybotActivation)
      .set({ signingDisabled: true, signerAdded: false, updatedAt: now })
      .where(eq(copybotActivation.userId, userId));
  }

  /**
   * Apply the SYSTEM signing-gate reconciler decision — deliberately ONE-WAY (#132). It may only ever CLEAR
   * `signing_disabled` (true → false), once the account is provably ready; it can NEVER re-set it. A leader CLOSE
   * returns funds and must always be signable, so a spent idle balance or a stopped last leader must never re-gate
   * signing. A genuine kill (revoked signer / operator, `signer_added=false`) keeps `signingReady` false, so
   * `clearSigningDisabled` is never requested for it — the kill is preserved. Also stamps `funded_at` the first time
   * the account is seen funded. Only writes when something actually changes (a no-op reconcile doesn't churn the row).
   */
  async applySigningGate(
    userId: string,
    next: { clearSigningDisabled: boolean; funded: boolean },
    now: number,
  ): Promise<void> {
    // Stamp funded_at ONCE (idempotent): only where it is still null and the wallet is now funded.
    if (next.funded) {
      await this.db
        .update(copybotActivation)
        .set({ fundedAt: now })
        .where(and(eq(copybotActivation.userId, userId), isNull(copybotActivation.fundedAt)));
    }
    // ONE-WAY: only ever CLEARS the gate (never sets it). Without a clear request, `signing_disabled` is untouched —
    // so this reconciler can neither re-gate a funded wallet that spent its idle balance nor clear a genuine kill.
    if (next.clearSigningDisabled) {
      await this.db
        .update(copybotActivation)
        .set({ signingDisabled: false, updatedAt: now })
        .where(eq(copybotActivation.userId, userId));
    }
  }
}
