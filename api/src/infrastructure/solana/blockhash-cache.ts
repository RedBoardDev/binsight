/**
 * Copy-bot — background-refreshed recent blockhash + its expiry. A blockhash stays valid ~60-90s, so refreshing
 * one every couple of seconds lets the hot path read it instantly instead of paying a `getLatestBlockhash`
 * round-trip (~100ms on WiFi). The brain only needs the blockhash to SERIALIZE (the vault re-sets a fresh one
 * before signing), so a slightly-stale cached value is fine there; the vault uses the pair for the first attempt
 * (and its `lastValidBlockHeight` to record the submitted tx's expiry) and re-fetches on retry.
 */

/** A recent blockhash paired with the block height past which it is provably expired (exactly-once recovery). */
export interface BlockhashInfo {
  blockhash: string;
  lastValidBlockHeight: number;
}

// Past this age a cached blockhash is treated as a MISS on the SIGN path (`getFresh`): it may already be at/near
// expiry, so the vault fetches a live blockhash for its first attempt instead of signing a possibly-dead hash.
// Chosen well under the ~60s blockhash validity floor so a value `getFresh` returns always has ample runway — and,
// crucially, during a prolonged RPC outage (the only time the background refresh cannot renew the cache) the stale
// value ages out here and the sign path stops trusting it. The SERIALIZE path (`get`) is deliberately unaffected:
// the vault re-sets a fresh blockhash before signing, so the brain's placeholder may be arbitrarily old.
export const BLOCKHASH_MAX_STALE_MS = 30_000;

export class BlockhashCache {
  private value: BlockhashInfo | undefined;
  private fetchedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly fetchFn: () => Promise<BlockhashInfo>,
    private readonly refreshMs = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Prime once (so `get()` is ready) then refresh in the background. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.(); // never keep the process alive just for this
  }

  /** Refresh, keeping the last good value if the fetch fails (transient RPC blip must not blank the cache).
   *  Only a SUCCESSFUL fetch bumps `fetchedAt`, so a stale-kept value ages toward the `getFresh` staleness cap. */
  async refresh(): Promise<void> {
    try {
      this.value = await this.fetchFn();
      this.fetchedAt = this.now();
    } catch {
      /* keep the previous value (do NOT bump fetchedAt — let it age out of the sign path) */
    }
  }

  /** Latest cached blockhash + expiry (SERIALIZE path). Throws if never primed (fail loud rather than serialize
   *  with a bogus hash). Not staleness-gated: the vault re-sets a fresh blockhash before signing. */
  get(): BlockhashInfo {
    if (this.value === undefined) throw new Error('blockhash cache not primed');
    return this.value;
  }

  /** SIGN path: the cached pair ONLY if fresh enough to submit with. Returns undefined (a MISS) if never primed or
   *  older than `BLOCKHASH_MAX_STALE_MS`, so the caller fetches a live blockhash instead of signing a stale one. */
  getFresh(): BlockhashInfo | undefined {
    if (this.value === undefined) return undefined;
    if (this.now() - this.fetchedAt > BLOCKHASH_MAX_STALE_MS) return undefined;
    return this.value;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
