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
    <>
      <AppTopBar />
      <main className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-6">
        <PortfolioGate>
          <div className="animate-rise">
            <PortfolioSummaryCard />
          </div>
          <IndexingBanner />
          <Tabs.Root
            variant="secondary"
            selectedKey={tab}
            onSelectionChange={(key) => setTab(key as Tab)}
          >
            <div className="flex items-end justify-between gap-3">
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
            <Tabs.Panel id="positions" className="animate-rise pt-5">
              <OpenPositionsTable />
            </Tabs.Panel>
            <Tabs.Panel id="stats" className="animate-rise pt-5">
              <StatsView />
            </Tabs.Panel>
            <Tabs.Panel id="history" className="animate-rise pt-5">
              <ClosedPositionsTable />
            </Tabs.Panel>
          </Tabs.Root>
        </PortfolioGate>
      </main>
      <PositionDetailPanel />
    </>
  );
};
