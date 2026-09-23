'use client';

import { useWalletScopeOptions } from '@app/applications/Wallet/Ui/useWalletScopeOptions';
import { Tabs } from '@heroui/react';

/** Desktop scope selector: the all-wallets aggregate plus one tab per watched wallet. */
export const WalletScopeTabs = () => {
  const options = useWalletScopeOptions();
  if (!options) return null;

  return (
    <Tabs.Root
      onSelectionChange={(key) => options.setScope(String(key))}
      selectedKey={options.scope}
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
          {options.wallets.map((wallet) => (
            <Tabs.Tab id={wallet.value} key={wallet.value}>
              {wallet.label}
              {wallet.indexing && <span className="text-faint"> · indexing…</span>}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs.Root>
  );
};
