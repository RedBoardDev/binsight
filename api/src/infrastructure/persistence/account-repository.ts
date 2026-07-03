import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type {
  AccountRepository,
  AccountSummary,
  AccountUser,
  InviteEntry,
  InviteRedeemFailure,
  WalletOverview,
} from '@/domain/ports';
import type { Database } from './database';
import {
  inviteCodes,
  positions as positionsTable,
  users as usersTable,
  userWatchedWallets as uww,
} from './schema';

/**
 * Postgres-backed accounts (Drizzle). Identity is the Privy DID (`did:privy:...`) — sessions are
 * 100% Privy, so there is no password / nonce / session state here. Also owns the single-use
 * invitation codes that gate account creation (owner-managed).
 */
export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly db: Database) {}

  private static toUser(r: {
    id: string;
    privyUserId: string;
    address: string | null;
    isOwner: boolean;
    createdAt: number;
  }): AccountUser {
    return {
      id: r.id,
      privyUserId: r.privyUserId,
      address: r.address,
      isOwner: r.isOwner,
      createdAt: r.createdAt,
    };
  }

  async createUser(p: { privyUserId: string; isOwner: boolean }): Promise<AccountUser> {
    const id = randomUUID();
    const createdAt = Date.now();
    await this.db.insert(usersTable).values({
      id,
      privyUserId: p.privyUserId,
      address: null,
      isOwner: p.isOwner,
      createdAt,
    });
    return { id, privyUserId: p.privyUserId, address: null, isOwner: p.isOwner, createdAt };
  }

  async findByPrivyId(did: string): Promise<AccountUser | null> {
    const [r] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.privyUserId, did))
      .limit(1);
    return r ? PostgresAccountRepository.toUser(r) : null;
  }

  async findById(id: string): Promise<AccountUser | null> {
    const [r] = await this.db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    return r ? PostgresAccountRepository.toUser(r) : null;
  }

  // ── Invite codes (owner-managed account-creation gate) ──────────────────────────────────────
  async createInvite(p: { code: string; note?: string; expiresAt?: number | null }): Promise<void> {
    await this.db.insert(inviteCodes).values({
      code: p.code,
      note: p.note ?? '',
      createdAt: Date.now(),
      expiresAt: p.expiresAt ?? null,
    });
  }

  async listInvites(): Promise<InviteEntry[]> {
    const rows = await this.db.select().from(inviteCodes).orderBy(inviteCodes.createdAt);
    return rows.map((r) => ({
      code: r.code,
      note: r.note,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      usedByUserId: r.usedByUserId,
      usedAt: r.usedAt,
    }));
  }

  async deleteInvite(code: string): Promise<boolean> {
    // Only an UNUSED code may be deleted: a redeemed code is the audit trail (code → account) and
    // deleting it would erase the traceability the invite gate exists for.
    const deleted = await this.db
      .delete(inviteCodes)
      .where(and(eq(inviteCodes.code, code), isNull(inviteCodes.usedByUserId)))
      .returning({ code: inviteCodes.code });
    return deleted.length > 0;
  }

  async redeemInviteAndCreateUser(p: {
    code: string;
    privyUserId: string;
    isOwner: boolean;
    now: number;
  }): Promise<{ ok: true; user: AccountUser } | { ok: false; reason: InviteRedeemFailure }> {
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      // Atomic claim: the UPDATE only lands while used_by_user_id is still NULL (and the code is
      // unexpired), so of two concurrent redeems of the SAME code exactly one gets a row back —
      // the loser falls through to the typed-failure diagnosis below. Claim + user insert share one
      // transaction: a failed insert rolls the claim back, never burning the code.
      const claimed = await tx
        .update(inviteCodes)
        .set({ usedByUserId: id, usedAt: p.now })
        .where(
          and(
            eq(inviteCodes.code, p.code),
            isNull(inviteCodes.usedByUserId),
            or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, p.now)),
          ),
        )
        .returning({ code: inviteCodes.code });
      if (claimed.length === 0) {
        // Diagnose WHY for a precise client error (the claim's WHERE collapses all failures).
        const [row] = await tx
          .select()
          .from(inviteCodes)
          .where(eq(inviteCodes.code, p.code))
          .limit(1);
        if (!row) return { ok: false as const, reason: 'not_found' as const };
        if (row.usedByUserId !== null) return { ok: false as const, reason: 'used' as const };
        return { ok: false as const, reason: 'expired' as const };
      }
      await tx.insert(usersTable).values({
        id,
        privyUserId: p.privyUserId,
        address: null,
        isOwner: p.isOwner,
        createdAt: p.now,
      });
      return {
        ok: true as const,
        user: {
          id,
          privyUserId: p.privyUserId,
          address: null,
          isOwner: p.isOwner,
          createdAt: p.now,
        },
      };
    });
  }

  // ── Admin: accounts ──────────────────────────────────────────────────────────────────────────
  async listAccounts(): Promise<AccountSummary[]> {
    const us = await this.db.select().from(usersTable).orderBy(usersTable.createdAt);
    const ws = await this.db.select({ userId: uww.userId, a: uww.walletAddress }).from(uww);
    const byUser = new Map<string, string[]>();
    for (const w of ws) {
      const arr = byUser.get(w.userId) ?? [];
      arr.push(w.a);
      byUser.set(w.userId, arr);
    }
    return us.map((u) => ({
      id: u.id,
      privyUserId: u.privyUserId,
      address: u.address,
      isOwner: u.isOwner,
      createdAt: u.createdAt,
      wallets: byUser.get(u.id) ?? [],
    }));
  }

  /** Delete an account + its watchlist; returns the wallets left with no watcher (so the engine can
   *  stop LIVE monitoring them). The wallets' SHARED position/flow data is KEPT (keyed by address,
   *  not by account) — revoking an account is "as if they never had one", the cached data survives
   *  for whoever watches the wallet next. */
  async deleteAccount(id: string): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const watched = (
        await tx.select({ a: uww.walletAddress }).from(uww).where(eq(uww.userId, id))
      ).map((r) => r.a);
      await tx.delete(uww).where(eq(uww.userId, id));
      const orphans: string[] = [];
      for (const addr of watched) {
        const [r] = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(uww)
          .where(eq(uww.walletAddress, addr));
        if (Number(r?.c ?? 0) === 0) orphans.push(addr);
      }
      await tx.delete(usersTable).where(eq(usersTable.id, id));
      return orphans;
    });
  }

  /** Per monitored wallet (anyone's watchlist): watcher count + open/closed position counts + the last
   *  time its positions were synced. Powers the admin Wallets tab; the route layers on live ingest
   *  status. SHARED data, keyed purely by address (independent of any account). */
  async walletOverview(): Promise<WalletOverview[]> {
    const watchers = await this.db
      .select({ address: uww.walletAddress, c: sql<number>`count(*)::int` })
      .from(uww)
      .groupBy(uww.walletAddress);
    const stats = await this.db
      .select({
        wallet: positionsTable.wallet,
        open: sql<number>`count(*) filter (where ${positionsTable.status} = 'open')::int`,
        closed: sql<number>`count(*) filter (where ${positionsTable.status} = 'closed')::int`,
        lastUpdate: sql<number | null>`max(${positionsTable.updatedAt})`,
      })
      .from(positionsTable)
      .groupBy(positionsTable.wallet);
    const byWallet = new Map(stats.map((s) => [s.wallet, s]));
    return watchers
      .map((w) => {
        const s = byWallet.get(w.address);
        return {
          address: w.address,
          watchers: Number(w.c),
          openPositions: Number(s?.open ?? 0),
          closedPositions: Number(s?.closed ?? 0),
          lastUpdate: s?.lastUpdate == null ? null : Number(s.lastUpdate),
        };
      })
      .sort((a, b) => b.watchers - a.watchers || a.address.localeCompare(b.address));
  }

  // ── Per-account watchlists ───────────────────────────────────────────────────────────────────
  async monitoredWallets(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ a: uww.walletAddress }).from(uww);
    return rows.map((r) => r.a);
  }

  async watchedBy(userId: string) {
    const rows = await this.db
      .select()
      .from(uww)
      .where(eq(uww.userId, userId))
      .orderBy(uww.createdAt);
    return rows.map((r) => ({
      address: r.walletAddress,
      label: r.label,
      color: r.color ?? undefined,
      createdAt: r.createdAt,
    }));
  }

  async watchedAddresses(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ a: uww.walletAddress })
      .from(uww)
      .where(eq(uww.userId, userId));
    return rows.map((r) => r.a);
  }

  async countWatched(userId: string): Promise<number> {
    const [r] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(uww)
      .where(eq(uww.userId, userId));
    return Number(r?.c ?? 0);
  }

  async isWatching(userId: string, address: string): Promise<boolean> {
    const [r] = await this.db
      .select({ a: uww.walletAddress })
      .from(uww)
      .where(and(eq(uww.userId, userId), eq(uww.walletAddress, address)))
      .limit(1);
    return Boolean(r);
  }

  async addWatch(
    userId: string,
    w: { address: string; label?: string; color?: string },
  ): Promise<void> {
    await this.db
      .insert(uww)
      .values({
        userId,
        walletAddress: w.address,
        label: w.label ?? '',
        color: w.color ?? null,
        createdAt: Date.now(),
      })
      .onConflictDoNothing();
  }

  async removeWatch(userId: string, address: string): Promise<number> {
    // Drop this user's watch and report the wallet's remaining watcher count. The wallet's SHARED
    // position/flow data is intentionally KEPT even when the count reaches 0 — it's keyed by address,
    // not by account, so re-adding the wallet later is instant (no re-download) and never duplicated.
    // The caller stops LIVE monitoring when the count is 0; the cached data simply lingers.
    return this.db.transaction(async (tx) => {
      await tx.delete(uww).where(and(eq(uww.userId, userId), eq(uww.walletAddress, address)));
      const [r] = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(uww)
        .where(eq(uww.walletAddress, address));
      return Number(r?.c ?? 0);
    });
  }
}
