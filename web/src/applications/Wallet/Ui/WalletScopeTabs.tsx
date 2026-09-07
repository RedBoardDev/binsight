'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { shortAddr } from '@app/applications/Shared/Domain/formatters';
import { useWallets } from '@app/applications/Wallet/Api/useWallets.api';
import { useOpenAccess } from '@app/core/Layout/OpenAccessContext';
import { Tabs } from '@heroui/react';

/** Desktop scope selector: the all-wallets aggregate plus one tab per watched wallet. */
export const WalletScopeTabs = () => {
  const scope = usePortfolioFeed((s) => s.scope);
  const setScope = usePortfolioFeed((s) => s.setScope);
  const { data } = useWallets();
  const openAccess = useOpenAccess();
  const wallets = data ?? [];

  // Nothing to switch between with 0 or 1 wallet — a single wallet makes "All" (the aggregate)
  // redundant since it equals that wallet. Open-access accounts are single-wallet by construction.
  if (openAccess || wallets.length <= 1) return null;

  return (
    <Tabs.Root
      onSelectionChange={(key) => setScope(String(key))}
      selectedKey={scope}
      variant="primary"
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label="Wallet scope">
          {/* RAC animates the indicator as a shared element BETWEEN tabs, so it has to live inside
              each tab — as a sibling it throws at render. */}
          <Tabs.Tab id="all">
            All
            <Tabs.Indicator />
          </Tabs.Tab>
          {wallets.map((wallet) => (
            <Tabs.Tab id={wallet.address} key={wallet.address}>
              {wallet.label || shortAddr(wallet.address)}
              {/* A freshly-added wallet still backfilling its history is not queryable yet. */}
              {wallet.ready === false && <span className="text-faint"> · indexing…</span>}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs.Root>
  );
};
