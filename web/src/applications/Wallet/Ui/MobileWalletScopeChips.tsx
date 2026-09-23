'use client';

import { useWalletScopeOptions } from '@app/applications/Wallet/Ui/useWalletScopeOptions';
import { ToggleButton, ToggleButtonGroup } from '@heroui/react';

/** Horizontally-scrollable scope selector: Overview + one chip per wallet. */
export const MobileWalletScopeChips = () => {
  const options = useWalletScopeOptions();
  if (!options) return null;

  const chips = [
    { label: 'Overview', value: 'all' },
    ...options.wallets.map((wallet) => ({
      label: `${wallet.label}${wallet.indexing ? ' · indexing…' : ''}`,
      value: wallet.value,
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
        if (next != null) options.setScope(String(next));
      }}
      selectedKeys={[options.scope]}
      selectionMode="single"
      size="md"
    >
      {chips.map((chip) => (
        <ToggleButton.Root
          // h-11 keeps the chip a 44px touch target on a phone (the md size is 40px).
          className="h-11 shrink-0 whitespace-nowrap rounded-full"
          id={chip.value}
          key={chip.value}
        >
          {chip.label}
        </ToggleButton.Root>
      ))}
    </ToggleButtonGroup.Root>
  );
};
