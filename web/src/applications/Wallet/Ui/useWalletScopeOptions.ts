'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { useWallets } from '@app/applications/Wallet/Api/useWallets.api';
import { useOpenAccess } from '@app/core/Layout/OpenAccessContext';

export interface WalletScopeOption {
  value: string;
  label: string;
  /** A freshly-added wallet still backfilling its history is not queryable yet. */
  indexing: boolean;
}

export interface WalletScopeOptions {
  scope: string;
  setScope: (scope: string) => void;
  /** One option per watched wallet; each selector adds its own label for the `all` aggregate. */
  wallets: WalletScopeOption[];
}

/**
 * The scope selector's logic, shared by the desktop tabs and the mobile chips. Null when there is
 * nothing to switch between: with 0 or 1 wallet the aggregate equals that wallet, and open-access
 * accounts are single-wallet by construction.
 */
export function useWalletScopeOptions(): WalletScopeOptions | null {
  const scope = usePortfolioFeed((s) => s.scope);
  const setScope = usePortfolioFeed((s) => s.setScope);
  const { data } = useWallets();
  const openAccess = useOpenAccess();
  const wallets = data ?? [];

  if (openAccess || wallets.length <= 1) return null;
  return {
    scope,
    setScope,
    wallets: wallets.map((wallet) => ({
      value: wallet.address,
      label: wallet.label || shortAddr(wallet.address),
      indexing: wallet.ready === false,
    })),
  };
}
