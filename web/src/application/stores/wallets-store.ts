import type { Wallet } from '@binsight/shared';
import { create } from 'zustand';
import { api } from '@/infrastructure/api/client';

/**
 * Single source for the watchlist + each wallet's onboarding status (`ready` / `indexedTxs`), shared by
 * the scope selector, the settings drawer and the indexing banner — so /wallets is fetched once, not
 * per component. While any wallet is still indexing its history, it self-polls so the "indexing…" state
 * clears the moment the backfill completes (no dedicated socket message needed).
 */
type WalletsState = {
  wallets: Wallet[];
  loaded: boolean;
  /**
   * True when the last fetch failed AND we have no wallets to show. Lets the UI tell a genuine
   * first-run empty watchlist (→ onboarding) apart from a transient /wallets failure (→ retry) —
   * otherwise both look identical (loaded + zero wallets) and a transient error masquerades as
   * first-run onboarding.
   */
  error: boolean;
  refresh: () => Promise<void>;
  stop: () => void;
};

const POLL_MS = 3000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
// Set by stop() so a refresh() whose api.wallets() was already in flight can't resurrect state / re-arm
// the poll after teardown (which would re-hit /wallets post-logout). Reset at the start of refresh().
let stopped = false;

const stopPoll = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

export const useWallets = create<WalletsState>((set, get) => ({
  wallets: [],
  loaded: false,
  error: false,
  refresh: async () => {
    stopped = false;
    try {
      const wallets = await api.wallets();
      if (stopped) return; // stop() landed during the await — don't resurrect state or re-arm the poll
      set({ wallets, loaded: true, error: false });
      // Poll only while something is indexing; stop as soon as everything is ready.
      const indexing = wallets.some((w) => w.ready === false);
      if (indexing && !pollTimer) pollTimer = setInterval(() => void get().refresh(), POLL_MS);
      else if (!indexing) stopPoll();
    } catch {
      if (stopped) return; // stop() landed during the await — don't resurrect state
      // Keep any wallets already on screen (a transient poll failure must not blank the list); flag an
      // error only when we have nothing to show, so the consumer renders retry, not the onboarding.
      set({ loaded: true, error: get().wallets.length === 0 });
    }
  },
  // Stop polling + drop state on teardown (logout / dashboard unmount) so the timer can't 401-loop.
  stop: () => {
    stopped = true;
    stopPoll();
    set({ wallets: [], loaded: false, error: false });
  },
}));
