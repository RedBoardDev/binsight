'use client';

import { type Tab, useUi } from '@/application/stores/ui-store';
import { useWallets } from '@/application/stores/wallets-store';
import { Tabs } from '@/presentation/ui';
import { AppShell } from './app-shell';
import { ClosedPositionsTable } from './closed-positions-table';
import { BotPanel } from './copybot/bot-panel';
import { EmptyWallets } from './empty-wallets';
import { IndexingBanner } from './indexing-banner';
import { OpenPositionsTable } from './open-positions-table';
import { PositionDrawer } from './position-drawer';
import { StatsPanel } from './stats-panel';
import { SummaryCard } from './summary-card';
import { TabsActions } from './tabs-actions';

const TABS: { label: string; value: Tab }[] = [
  { label: 'Positions', value: 'positions' },
  { label: 'Stats', value: 'stats' },
  { label: 'History', value: 'history' },
  { label: 'Bot', value: 'bot' },
];

/** The desktop (≥ md) composition — the existing, intentionally-frozen dashboard layout. */
export function DesktopShell() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const noWallets = useWallets((s) => s.loaded && s.wallets.length === 0);

  return (
    <>
      <AppShell />
      <main className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-6">
        {/* The empty-watchlist state replaces the position views only — the Bot tab (custody/activation) is
            reachable even with no watched wallets (a freshly-registered account has none yet). */}
        {noWallets && tab !== 'bot' ? (
          <EmptyWallets />
        ) : (
          <>
            {tab !== 'bot' && (
              <>
                <div className="rise">
                  <SummaryCard />
                </div>
                <IndexingBanner />
              </>
            )}
            <div className="flex items-end justify-between gap-3 border-border border-b">
              <Tabs options={TABS} value={tab} onChange={setTab} />
              {tab !== 'bot' && <TabsActions />}
            </div>
            {/* Mounted per tab (not CSS-hidden), so the Stats fetches + chart only run when opened. */}
            <div key={tab} className="rise">
              {tab === 'positions' && <OpenPositionsTable />}
              {tab === 'stats' && <StatsPanel />}
              {tab === 'history' && <ClosedPositionsTable />}
              {tab === 'bot' && <BotPanel />}
            </div>
          </>
        )}
      </main>
      <PositionDrawer />
    </>
  );
}
