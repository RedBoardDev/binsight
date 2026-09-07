'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { SettingsPanel } from '@app/applications/Settings/Ui/SettingsPanel';
import { useIsMobile, useIsMounted } from '@app/applications/Shared/Ui/useIsMobile';
import { DesktopShell } from '@app/core/Layout/DesktopShell';
import { MobileShell } from '@app/core/Layout/MobileShell';
import { OpenAccessProvider } from '@app/core/Layout/OpenAccessContext';
import { UrlState } from '@app/core/Layout/UrlState';
import { Suspense, useEffect } from 'react';

interface DashboardProps {
  openAccess: boolean;
}

/**
 * The single fork point between the desktop composition and the dedicated mobile tree, and the
 * owner of the shared bootstrap (the live portfolio feed). The mount gate avoids a first-paint flash
 * between the server's desktop assumption and the resolved viewport; only the chosen subtree mounts,
 * so stores and queries are never subscribed twice.
 */
export const Dashboard = ({ openAccess }: DashboardProps) => {
  const start = usePortfolioFeed((s) => s.start);
  const stop = usePortfolioFeed((s) => s.stop);
  const mounted = useIsMounted();
  const isMobile = useIsMobile();

  useEffect(() => {
    start();
    return () => stop();
  }, [start, stop]);

  return (
    <OpenAccessProvider value={openAccess}>
      <div className="min-h-dvh">
        <Suspense fallback={null}>
          <UrlState />
        </Suspense>
        {mounted ? isMobile ? <MobileShell /> : <DesktopShell /> : null}
        <SettingsPanel />
      </div>
    </OpenAccessProvider>
  );
};
