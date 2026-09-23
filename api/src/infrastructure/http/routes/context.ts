import type { FastifyInstance } from 'fastify';
import type { AccountRepository } from '@/domain/ports';
import { TtlCache } from '@/util/cache';

/**
 * Per-request watchlist resolution shared by every route module. A watchlist only changes through the
 * WatchlistService (which invalidates it here), so it is cached briefly instead of costing a query on
 * every read.
 */
export class WatchScope {
  private readonly cache = new TtlCache<string[]>(15_000);

  constructor(private readonly accounts: AccountRepository) {}

  async watchedOf(userId: string): Promise<string[]> {
    const hit = this.cache.get(userId);
    if (hit) return hit;
    const watched = await this.accounts.watchedAddresses(userId);
    this.cache.set(userId, watched);
    return watched;
  }

  /** The wallets a request may see: one watched wallet, or the caller's whole watchlist. */
  async wallets(userId: string, wallet?: string): Promise<string[]> {
    const watched = await this.watchedOf(userId);
    if (wallet && wallet !== 'all') return watched.includes(wallet) ? [wallet] : [];
    return watched;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}

/** An integer query parameter clamped to [min, max]; anything unparseable falls back to `fallback`.
 *  (`Number('x')` is NaN and survives Math.min/max — drizzle then silently drops the LIMIT.) */
export function intParam(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** How many days of history a "days" query may ask for (the web's "All" period sends this). */
export const MAX_HISTORY_DAYS = 3650;

/** A route handler registrar for one resource. */
export type RouteModule<D> = (app: FastifyInstance, deps: D) => void;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without a session (the auth hook skips it). */
    public?: boolean;
  }
}
