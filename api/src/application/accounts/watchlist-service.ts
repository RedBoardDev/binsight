import type { AccountRepository } from '@/domain/ports';
import { KeyedSerializer } from '@/util/concurrency';

/** Per-account watchlist size (the owner is exempt). Doubles as admission control. */
export const MAX_WALLETS_PER_ACCOUNT = 3;
/** Global ceiling on distinct monitored wallets — protects the shared Helius budget. */
export const GLOBAL_WALLET_CAP = 200;

/** The engine side of a watchlist change: start or stop monitoring a wallet. */
export interface WalletMonitor {
  addWallet(address: string): Promise<void>;
  removeWallet(address: string): void;
}

export type WatchResult =
  | { ok: true }
  | { ok: false; reason: 'account-limit'; limit: number }
  | { ok: false; reason: 'capacity' };

/**
 * The one place a wallet enters or leaves monitoring. Both caps are check-then-insert, so admissions run
 * one at a time — two parallel adds used to pass the same count and overshoot either cap, each one
 * starting a full-history backfill.
 */
export class WatchlistService {
  private readonly admission = new KeyedSerializer();
  private readonly listeners = new Set<(userId: string) => void>();

  constructor(
    private readonly accounts: AccountRepository,
    private readonly monitor: WalletMonitor,
    private readonly openAccess: boolean,
  ) {}

  /** Called with the user whose watchlist changed (cache invalidation). */
  onChange(listener: (userId: string) => void): void {
    this.listeners.add(listener);
  }

  async add(
    account: { id: string; isOwner: boolean },
    wallet: { address: string; label?: string; color?: string },
  ): Promise<WatchResult> {
    const result = await this.admission.run('admission', async (): Promise<WatchResult> => {
      const { address } = wallet;
      if (!account.isOwner && !(await this.accounts.isWatching(account.id, address))) {
        // Open-access accounts are single-wallet: the registration address is already watched.
        const limit = this.openAccess ? 1 : MAX_WALLETS_PER_ACCOUNT;
        if ((await this.accounts.countWatched(account.id)) >= limit) {
          return { ok: false, reason: 'account-limit', limit };
        }
        const monitored = await this.accounts.monitoredWallets();
        if (!monitored.includes(address) && monitored.length >= GLOBAL_WALLET_CAP) {
          return { ok: false, reason: 'capacity' };
        }
      }
      await this.accounts.addWatch(account.id, wallet);
      return { ok: true };
    });
    if (!result.ok) return result;
    this.changed(account.id);
    await this.monitor.addWallet(wallet.address);
    return result;
  }

  /** A new account watches its own registration wallet — it IS the account, so no cap applies. */
  async watchRegistration(userId: string, address: string): Promise<void> {
    await this.accounts.addWatch(userId, { address });
    this.changed(userId);
    await this.monitor.addWallet(address);
  }

  async remove(userId: string, address: string): Promise<void> {
    const remaining = await this.accounts.removeWatch(userId, address);
    this.changed(userId);
    // Last watcher gone → stop monitoring the wallet entirely.
    if (remaining === 0) this.monitor.removeWallet(address);
  }

  /** Delete an account; wallets it was the last watcher of stop being monitored. Returns how many. */
  async deleteAccount(userId: string): Promise<number> {
    const orphaned = await this.accounts.deleteAccount(userId);
    this.changed(userId);
    for (const w of orphaned) this.monitor.removeWallet(w);
    return orphaned.length;
  }

  private changed(userId: string): void {
    for (const l of this.listeners) l(userId);
  }
}
