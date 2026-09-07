'use client';

import { PortfolioSummaryCard } from '@app/applications/Portfolio/Ui/PortfolioSummaryCard';
import { ClosedPositionsTable } from '@app/applications/Position/Ui/ClosedPositionsTable';
import { OpenPositionsTable } from '@app/applications/Position/Ui/OpenPositionsTable';
import { PositionDetailPanel } from '@app/applications/Position/Ui/PositionDetailPanel';
import { StatsView } from '@app/applications/Stats/Ui/StatsView';
import { IndexingBanner } from '@app/applications/Wallet/Ui/IndexingBanner';
import { AppTopBar } from '@app/core/Layout/AppTopBar';
import { PortfolioGate } from '@app/core/Layout/PortfolioGate';
import { ScopeActions } from '@app/core/Layout/ScopeActions';
import { type Tab, useUi } from '@app/core/stores/uiStore';
import { Tabs } from '@heroui/react';

const TABS: { label: string; value: Tab }[] = [
  { label: 'Positions', value: 'positions' },
  { label: 'Stats', value: 'stats' },
  { label: 'History', value: 'history' },
];

export const DesktopShell = () => {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);

  return (
    // Fixed-viewport shell: the document never scrolls. The header, the portfolio hero and the tab
    // row stay put, and the panel below them is the only thing that scrolls — so the figures you
    // navigate by are always on screen.
    <div className="flex h-dvh flex-col overflow-hidden">
      <AppTopBar />
      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 overflow-hidden px-6 py-6">
        <PortfolioGate>
          <div className="animate-rise shrink-0">
            <PortfolioSummaryCard />
          </div>
          <IndexingBanner />
          <Tabs.Root
            variant="secondary"
            selectedKey={tab}
            onSelectionChange={(key) => setTab(key as Tab)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex shrink-0 items-end justify-between gap-3">
              <Tabs.ListContainer className="flex-1">
                <Tabs.List aria-label="Dashboard sections">
                  {TABS.map((t) => (
                    <Tabs.Tab key={t.value} id={t.value}>
                      {t.label}
                      {/* RAC animates the indicator as a shared element BETWEEN tabs, so it has to
                          live inside each tab — as a sibling it throws at render. */}
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs.ListContainer>
              <ScopeActions />
            </div>
            {/* Each panel mounts only when opened, so the Stats fetches and the chart never run on
                a plain reload (which lands on Positions). */}
            <Tabs.Panel id="positions" className="animate-rise min-h-0 flex-1 pt-5">
              <OpenPositionsTable />
            </Tabs.Panel>
            {/* Stats is a stack of cards rather than one table, so it keeps its own scroller. */}
            <Tabs.Panel id="stats" className="animate-rise min-h-0 flex-1 overflow-y-auto pt-5">
              <StatsView />
            </Tabs.Panel>
            <Tabs.Panel id="history" className="animate-rise min-h-0 flex-1 pt-5">
              <ClosedPositionsTable />
            </Tabs.Panel>
          </Tabs.Root>
        </PortfolioGate>
      </main>
      <PositionDetailPanel />
    </div>
  );
};
