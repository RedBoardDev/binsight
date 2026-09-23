'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { useWallets } from '@app/applications/Wallet/Api/useWallets.api';
import { useOpenAccess } from '@app/core/Layout/OpenAccessContext';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';

/** Horizontally-scrollable scope selector: Overview + one chip per wallet. */
export const MobileWalletScopeChips = () => {
  const scope = usePortfolioFeed((s) => s.scope);
  const setScope = usePortfolioFeed((s) => s.setScope);
  const { data } = useWallets();
  const openAccess = useOpenAccess();
  const wallets = data ?? [];

  // Nothing to switch between with 0 or 1 wallet — a single wallet makes "Overview" (the aggregate)
  // redundant since it equals that wallet. Open-access accounts are single-wallet by construction.
  if (openAccess || wallets.length <= 1) return null;

  const options = [
    { label: 'Overview', value: 'all' },
    ...wallets.map((wallet) => ({
      // A freshly-added wallet still backfilling its history is not queryable yet.
      label: `${wallet.label || shortAddr(wallet.address)}${wallet.ready === false ? ' · indexing…' : ''}`,
      value: wallet.address,
    })),
  ];

  return (
    <ToggleButtonGroup.Root
      aria-label="Wallet scope"
      className="scrollbar-none flex gap-2 overflow-x-auto px-4 py-2"
      disallowEmptySelection
      isDetached
      onSelectionChange={(keys) => {
        const [next] = [...keys];
        if (next != null) setScope(String(next));
      }}
      selectedKeys={[scope]}
      selectionMode="single"
      size="md"
    >
      {options.map((option) => (
        <ToggleButton.Root
          // h-11 keeps the chip a 44px touch target on a phone (the md size is 40px).
          className="h-11 shrink-0 whitespace-nowrap rounded-full"
          id={option.value}
          key={option.value}
        >
          {option.label}
        </ToggleButton.Root>
      ))}
    </ToggleButtonGroup.Root>
  );
};
