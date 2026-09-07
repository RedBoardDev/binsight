import { Portfolio } from '@app/applications/Portfolio/Domain/portfolio';
import { apiGet } from '@app/applications/Shared/Api/httpClient';
import { LiveClient } from '@app/core/realtime/LiveClient';
import type { Health, WalletState } from '@binsight/shared';
import { create } from 'zustand';

type PortfolioState = {
  portfolio: Portfolio | null;
  health: Health | null;
  connected: boolean;
  scope: string;
  /** True between a scope switch and the new scope's first payload — so the UI can DIM the previous
   *  scope's data (kept on screen) instead of blanking to skeletons on every wallet switch. */
  scopeLoading: boolean;
  /** True when the initial /state fetch failed and no socket payload has populated the portfolio
   *  yet — lets the view show an explicit error + retry instead of skeletons forever (loading vs
   *  broken). Cleared the moment any current-scope payload lands (REST or socket recovery). */
  error: boolean;
  /** Bumped whenever a position closes — components key their closed/stats refetch on it. */
  closedVersion: number;
  start: () => void;
  stop: () => void;
  setScope: (scope: string) => void;
  /** Re-attempt the current scope's /state fetch after a failure (the socket self-reconnects). */
  retry: () => void;
};

// The live socket lives outside the store (not serializable, single instance per session).
let client: LiveClient | null = null;

export const usePortfolioFeed = create<PortfolioState>((set, get) => {
  // Apply a WalletState only if it still matches the active scope (drops stale/out-of-order payloads).
  // A landed payload also clears any prior error — a socket recovery heals the view on its own.
  const setIfCurrent = (s: WalletState) => {
    if (s.scope !== get().scope) return;
    set({ portfolio: new Portfolio(s), scopeLoading: false, error: false });
  };

  const applyState = (scope: string) =>
    apiGet<WalletState>(`state?wallet=${encodeURIComponent(scope)}`)
      .then(setIfCurrent)
      // On REST failure, clear scopeLoading and raise `error` ONLY if this scope is still current —
      // otherwise it could stick `true` forever when no matching socket payload arrives (a stale
      // failure must not clobber a newer scope's loading/error state).
      .catch(() => {
        if (get().scope === scope) set({ scopeLoading: false, error: true });
      });

  return {
    portfolio: null,
    health: null,
    connected: false,
    scope: 'all',
    scopeLoading: false,
    error: false,
    closedVersion: 0,

    start: () => {
      if (client) return;
      client = new LiveClient({
        onState: setIfCurrent,
        onHealth: (health) => set({ health }),
        // Live events don't bump the closed/stats refetch — the server emits a dedicated
        // closed_changed (onClosedChanged) when a position actually closes.
        onEvent: () => {},
        onClosedChanged: () => set((st) => ({ closedVersion: st.closedVersion + 1 })),
        onConnectionChange: (connected) => set({ connected }),
      });
      void client.connect(get().scope);
      void applyState(get().scope); // fast first paint before the socket opens
    },

    stop: () => {
      client?.disconnect();
      client = null;
      set({ connected: false, error: false });
    },

    setScope: (scope) => {
      if (scope === get().scope) return;
      // Keep the previous scope's data on screen (dimmed via scopeLoading) — no blank-to-skeleton on
      // every wallet switch. setIfCurrent clears scopeLoading once the new scope's payload lands. Drop
      // any stale error: the new scope gets a fresh loading attempt, not the old one's failure.
      set({ scope, scopeLoading: true, error: false });
      client?.subscribe(scope);
      void applyState(scope);
    },

    // Manual recovery from the error state: re-run the current scope's /state fetch. The socket
    // reconnects on its own (capped backoff), so re-fetching REST is enough to repaint on recovery.
    retry: () => {
      set({ scopeLoading: true, error: false });
      void applyState(get().scope);
    },
  };
});
