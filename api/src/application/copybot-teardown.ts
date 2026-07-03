/**
 * Copy-bot · Inc.4e — the account-TEARDOWN service (#56, SPEC §2.4). Account deletion IRREVERSIBLY soft-detaches the
 * Privy wallet, so this is a SYSTEM-enforced gate, not a UX affordance. The pure `canTeardown` decides the entry
 * guard; this service orchestrates the ordered, fund-safe teardown around it.
 *
 * Ordering (documented, fund-safety-critical):
 *   gate (canTeardown) → stop the bot (force-close all mirrors, re-swap to SOL) → CONFIRM no open mirrors remain →
 *   Privy user delete (LAST, irreversible) → local user-scoped cascade.
 * If the Privy delete FAILS we surface it and do NOT run the local cascade — the account stays fully intact so the
 * operation is idempotently retryable (never half-deleted with a live Privy wallet the user can no longer reach). The
 * force-close + re-confirm before the delete is the never-miss backstop: a delete can never strand an open position.
 */
import type { Logger } from 'pino';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { canTeardown, DUST_LAMPORTS, type TeardownRefusal } from '@/domain/copybot/teardown';
import type { CopybotActivationRepository } from '@/infrastructure/persistence/copybot-activation-repository';

export interface CopybotTeardownDeps {
  activation: CopybotActivationRepository;
  /** OPEN mirror count for the user — the gate input AND the post-force-close confirm. */
  openMirrorCount: (userId: string) => Promise<number>;
  /** Live wallet balance (lamports). */
  balances: (address: string) => Promise<number>;
  /** Stop the bot for THIS user = set config `enabled=false` + control ping → the stop=force-close path (SPEC §4.3). */
  stopBot: (userId: string) => Promise<void>;
  /** IRREVERSIBLY delete the Privy user (soft-detach the wallet). Only called once the account is provably empty. */
  deletePrivyUser: (privyUserId: string) => Promise<void>;
  /** Clear ALL local user-scoped rows in one transaction (accounts.deleteAccount cascade). */
  deleteLocalCascade: (userId: string) => Promise<void>;
  log: Logger;
}

/** Typed teardown outcome — the route maps each reason to its HTTP status (409 gate/in-progress, 502 Privy, 403 SYSTEM). */
export type TeardownResult =
  | { ok: true }
  | { ok: false; reason: TeardownRefusal | 'in_progress' | 'privy_delete_failed' | 'system_user' };

export class CopybotTeardownService {
  constructor(private readonly deps: CopybotTeardownDeps) {}

  async teardown(userId: string, privyUserId: string): Promise<TeardownResult> {
    // The SYSTEM/bench tenant is never a deletable account (it has no Privy user + owns the bench keypair path).
    if (userId === SYSTEM_USER_ID) {
      this.deps.log.error({ userId }, 'teardown refused: the SYSTEM user cannot be torn down');
      return { ok: false, reason: 'system_user' };
    }

    const activation = await this.deps.activation.find(userId);
    const signable = await this.deps.activation.resolveSignableWallet(userId);
    const address = signable?.address ?? null;
    const balanceLamports = address ? await this.deps.balances(address) : 0;
    const openMirrorCount = await this.deps.openMirrorCount(userId);

    // ── Entry gate: refuse an irreversible delete over locked capital / funds without a withdrawal-or-export ack ──
    const gate = canTeardown({
      openMirrorCount,
      balanceLamports,
      withdrawalAck: activation?.withdrawalAckAt != null,
      exportAck: activation?.exportAckAt != null,
      dustLamports: DUST_LAMPORTS,
    });
    if (!gate.ok) return { ok: false, reason: gate.reason };

    // (1) Stop the bot for this user → force-close every mirror + re-swap to SOL (the existing stop=force-close path).
    await this.deps.stopBot(userId);

    // (2) CONFIRM no open mirrors remain before the irreversible delete (never-miss). A force-close still in flight →
    //     tell the caller to retry; the reconcile keeps closing, and nothing is deleted while a position is open.
    if ((await this.deps.openMirrorCount(userId)) > 0) return { ok: false, reason: 'in_progress' };

    // (3) Privy user delete — IRREVERSIBLE, LAST before the local cascade. Only when the account actually has a
    //     provisioned Privy wallet; on failure, surface it and DO NOT half-delete locally (idempotently retryable).
    if (activation?.privyWalletId) {
      try {
        await this.deps.deletePrivyUser(privyUserId);
      } catch (e) {
        this.deps.log.error(
          { userId, err: (e as Error).message },
          'teardown: Privy user delete FAILED — aborting before the local cascade (retryable, nothing deleted)',
        );
        return { ok: false, reason: 'privy_delete_failed' };
      }
    }

    // (4) Local cascade (one transaction): clear every user-scoped row for this account.
    await this.deps.deleteLocalCascade(userId);
    this.deps.log.warn({ userId }, 'account torn down (Privy detached + local rows cascaded)');
    return { ok: true };
  }
}
