'use client';

import { MobilePortfolioStats } from '@app/applications/Portfolio/Ui/MobilePortfolioStats';
import { MobilePortfolioSummary } from '@app/applications/Portfolio/Ui/MobilePortfolioSummary';
import { MobileClosedPositionsList } from '@app/applications/Position/Ui/MobileClosedPositionsList';
import { MobileOpenPositionsList } from '@app/applications/Position/Ui/MobileOpenPositionsList';
import { PositionDetailPanel } from '@app/applications/Position/Ui/PositionDetailPanel';
import { StatsView } from '@app/applications/Stats/Ui/StatsView';
import { IndexingBanner } from '@app/applications/Wallet/Ui/IndexingBanner';
import { MobileWalletScopeChips } from '@app/applications/Wallet/Ui/MobileWalletScopeChips';
import { AppTopBar } from '@app/core/Layout/AppTopBar';
import { MobileTabBar } from '@app/core/Layout/MobileTabBar';
import { PortfolioGate } from '@app/core/Layout/PortfolioGate';
import { useUi } from '@app/core/stores/uiStore';

export const MobileShell = () => {
  const tab = useUi((s) => s.tab);

  return (
    <div className="flex min-h-dvh flex-col">
      <AppTopBar compact />
      <MobileWalletScopeChips />
      {/* Bottom padding clears the fixed tab bar and its safe-area inset. */}
      <main className="flex-1 px-4 pt-1 pb-[calc(5rem+env(safe-area-inset-bottom))]">
        <PortfolioGate>
          <div className="flex flex-col gap-4">
            <MobilePortfolioSummary />
            <IndexingBanner />
            {tab === 'positions' ? (
              <>
                <MobilePortfolioStats />
                <MobileOpenPositionsList />
              </>
            ) : tab === 'stats' ? (
              <StatsView />
            ) : (
              <MobileClosedPositionsList />
            )}
          </div>
        </PortfolioGate>
      </main>
      <MobileTabBar />
      <PositionDetailPanel />
    </div>
  );
};
