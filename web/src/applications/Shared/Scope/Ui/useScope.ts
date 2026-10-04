import type { Period } from '@app/applications/Shared/Scope/Domain/period';
import type { ScopeSearch } from '@app/applications/Shared/Scope/Domain/scopeSearch';
import type { WalletScope } from '@app/applications/Shared/Scope/Domain/walletScope';
import { useNavigate, useSearch } from '@tanstack/react-router';

interface Scope extends ScopeSearch {
  readonly setWallet: (wallet: WalletScope) => void;
  readonly setPeriod: (period: Period) => void;
}

// The wallet and the period of every signed-in page, read from and written to the URL. A change
// replaces the history entry: a filter is not a place to go back to.
export const useScope = (): Scope => {
  const { wallet, period } = useSearch({ from: '/_authenticated' });
  const navigate = useNavigate();

  return {
    wallet,
    period,
    setWallet: (next) =>
      void navigate({
        to: '.',
        search: (previous) => ({ ...previous, wallet: next }),
        replace: true,
      }),
    setPeriod: (next) =>
      void navigate({
        to: '.',
        search: (previous) => ({ ...previous, period: next }),
        replace: true,
      }),
  };
};
