/**
 * Copy-bot · Inc.4e — the funds SERVICE for the withdraw UI (Path B, SPEC §2.2). It is READ-ONLY over the wallet
 * (never signs — the user signs the transfer with their OWN Privy authority client-side) plus the lightweight
 * withdrawal-ack write that closes the teardown loop. F5 firewall: this module imports NEITHER the coffre signer nor
 * the PRIVY_AUTHORIZATION_KEY — the withdrawal is the user's credential, not the coffre's.
 */
import type { Logger } from 'pino';
import { WITHDRAW_RESERVE_LAMPORTS, withdrawableLamports } from '@/domain/copybot/withdrawable';
import type { CopybotActivationRepository } from '@/infrastructure/persistence/copybot-activation-repository';

/** Lamports per SOL (local per-module const — the project convention). */
const LAMPORTS_PER_SOL = 1_000_000_000;

export interface CopybotFundsDeps {
  repo: CopybotActivationRepository;
  /** Live wallet balance (lamports) — a short-TTL getBalance in prod, a fake in tests. */
  balances: (address: string) => Promise<number>;
  /** SOL committed to the user's OPEN mirrors, in LAMPORTS — conservatively excluded from the offered amount. */
  deployedLamports: (userId: string) => Promise<number>;
  log: Logger;
}

/** The withdrawable snapshot the UI reads to cap the amount (all values in lamports + a SOL convenience). */
export interface WithdrawableView {
  address: string | null;
  balanceLamports: number;
  deployedLamports: number;
  reserveLamports: number;
  withdrawableLamports: number;
  withdrawableSol: number;
}

export class CopybotFundsService {
  constructor(private readonly deps: CopybotFundsDeps) {}

  /** The free (non-deployed, minus reserve) SOL the UI offers for withdrawal. Read-only; nothing signs here. */
  async withdrawable(userId: string): Promise<WithdrawableView> {
    const signable = await this.deps.repo.resolveSignableWallet(userId);
    const address = signable?.address ?? null;
    const balanceLamports = address ? await this.deps.balances(address) : 0;
    const deployedLamports = await this.deps.deployedLamports(userId);
    const reserveLamports = WITHDRAW_RESERVE_LAMPORTS;
    const free = withdrawableLamports({ balanceLamports, deployedLamports, reserveLamports });
    return {
      address,
      balanceLamports,
      deployedLamports,
      reserveLamports,
      withdrawableLamports: free,
      withdrawableSol: free / LAMPORTS_PER_SOL,
    };
  }

  /** Record that the user completed a withdrawal (Path B) — stamps `withdrawal_ack_at` so the teardown gate (SPEC
   *  §2.4) sees a completed withdrawal. The transfer itself was signed + sent by the user's OWN Privy client. */
  async acknowledgeWithdrawal(userId: string): Promise<void> {
    await this.deps.repo.markWithdrawalAck(userId, Date.now());
  }
}
