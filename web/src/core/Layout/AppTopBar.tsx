'use client';

import { HealthIndicator } from '@app/applications/Health/Ui/HealthIndicator';
import { WalletScopeTabs } from '@app/applications/Wallet/Ui/WalletScopeTabs';
import { BrandMark } from '@app/core/Layout/BrandMark';
import { DisplayControls } from '@app/core/Layout/DisplayControls';
import { cn } from '@heroui/react';

interface AppTopBarProps {
  /** Phones drop the inline scope selector (it becomes a chip row below the bar), pad for the
   *  notch, and get larger touch targets. */
  compact?: boolean;
}

/** The one top bar. Sign-out is deliberately not here — it lives in the settings drawer, so the
 *  phone and the desktop offer it in exactly one place. */
export const AppTopBar = ({ compact = false }: AppTopBarProps) => (
  <header
    className={cn(
      'sticky top-0 z-20 border-border border-b backdrop-blur-xl',
      compact ? 'bg-background/80 pt-[env(safe-area-inset-top)]' : 'bg-background/70',
    )}
  >
    <div
      className={cn(
        'flex items-center justify-between gap-3',
        compact ? 'px-4 py-2.5' : 'mx-auto max-w-6xl px-6 py-3.5',
      )}
    >
      <BrandMark />
      <div className="flex min-w-0 items-center gap-1.5">
        {/* Only the scope tabs scroll horizontally: the health popover must NOT sit inside an
              overflow container, or the bar would gain a vertical scrollbar with it. */}
        {!compact && (
          <div className="-mx-1 min-w-0 overflow-x-auto px-1">
            <WalletScopeTabs />
          </div>
        )}
        <HealthIndicator />
        <DisplayControls size={compact ? 'md' : 'sm'} />
      </div>
    </div>
  </header>
);
