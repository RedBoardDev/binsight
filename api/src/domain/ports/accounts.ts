import type { AccessEntry, WalletOverview } from '@binsight/shared';

/** Accounts, sessions, the invite whitelist and per-account watchlists — the multi-tenant boundary. */

/** A public-web account (or the seeded owner). */
export interface AccountUser {
  id: string;
  /** The Solana wallet address = identity / username. */
  address: string;
  isOwner: boolean;
  /** JWT generation counter; bumped on password reset to kill existing sessions. */
  tokenVersion: number;
}

/** One wallet on a user's watchlist. */
export interface WatchedWallet {
  address: string;
  label: string;
  color?: string;
  createdAt: number;
}

export interface WhitelistEntry {
  address: string;
  note: string;
  addedBy: string;
  createdAt: number;
}

export interface AccountSummary {
  id: string;
  address: string;
  isOwner: boolean;
  createdAt: number;
  /** The wallets this account watches (the registration address first). */
  wallets: string[];
}

/** What a signature nonce is for — binds a challenge to its intended action. */
export type NoncePurpose = 'register' | 'reset';

export interface AccountRepository {
  /** Seed the owner allowlist entry (OWNER_ADDRESS) so the owner can register the bootstrap account. */
  init(ownerAddress: string): Promise<void>;
  createUser(p: { address: string; passwordHash: string; isOwner: boolean }): Promise<AccountUser>;
  findByAddress(address: string): Promise<{ user: AccountUser; passwordHash: string } | null>;
  findById(id: string): Promise<AccountUser | null>;
  /** The account for `id` only if its `jti` session is still valid — one JOIN for the auth hot path. */
  findByIdWithSession(id: string, jti: string): Promise<AccountUser | null>;
  /** Replace a user's password hash AND bump tokenVersion (invalidates existing sessions). */
  resetPassword(id: string, passwordHash: string): Promise<void>;

  // ── Whitelist (owner-managed registration gate) ──
  isWhitelisted(address: string): Promise<boolean>;
  listWhitelist(): Promise<WhitelistEntry[]>;
  addWhitelist(p: { address: string; note?: string; addedBy?: string }): Promise<void>;
  removeWhitelist(address: string): Promise<void>;

  // ── Signature nonces (single-use, purpose-bound) ──
  issueNonce(
    address: string,
    nonce: string,
    expiresAt: number,
    purpose: NoncePurpose,
  ): Promise<void>;
  /** Atomically consume a nonce for an (address, purpose): true iff it existed, matched the purpose,
   *  and was unexpired. The purpose binding stops a register challenge being used to reset (or vice versa). */
  consumeNonce(address: string, nonce: string, purpose: NoncePurpose): Promise<boolean>;

  // ── Session allowlist (one row per issued JWT jti) for real logout + revocation ──
  createSession(jti: string, userId: string, expiresAt: number): Promise<void>;
  /** True iff `jti` is a known, unexpired session — the per-request auth gate. */
  isSessionValid(jti: string): Promise<boolean>;
  /** Revoke one session (logout). */
  deleteSession(jti: string): Promise<void>;
  /** Revoke ALL of a user's sessions (on password reset). */
  deleteUserSessions(userId: string): Promise<void>;

  // ── Admin: accounts ──
  listAccounts(): Promise<AccountSummary[]>;
  /** Unified admin access list (invited + joined, merged by address). */
  listAccess(): Promise<AccessEntry[]>;
  /** Per-monitored-wallet operational stats for the admin Wallets tab. */
  walletOverview(): Promise<WalletOverview[]>;
  /** Delete an account + its watchlist + its sessions; returns the wallets left with no watcher (engine
   *  stops LIVE monitoring them). Shared position/flow data is KEPT (keyed by address), never evicted. */
  deleteAccount(id: string): Promise<string[]>;

  /** Distinct wallet addresses watched by anyone — the engine's monitored set. */
  monitoredWallets(): Promise<string[]>;
  watchedBy(userId: string): Promise<WatchedWallet[]>;
  watchedAddresses(userId: string): Promise<string[]>;
  countWatched(userId: string): Promise<number>;
  isWatching(userId: string, address: string): Promise<boolean>;
  /** Add a wallet to a user's watchlist. Idempotent. */
  addWatch(userId: string, w: { address: string; label?: string; color?: string }): Promise<void>;
  /** Remove from a user's watchlist; returns the remaining watcher count for that wallet. */
  removeWatch(userId: string, address: string): Promise<number>;
}
