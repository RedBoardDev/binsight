import { RealtimeStatusIndicator } from '@app/applications/Realtime/Ui/RealtimeStatusIndicator';
import { useIsDesktop } from '@app/applications/Shared/Layout/Ui/useIsDesktop';
import { Brand } from '@app/core/Layout/AppShell/Brand';
import { DesktopNav } from '@app/core/Layout/AppShell/DesktopNav';
import { PageColumn } from '@app/core/Layout/AppShell/PageColumn';
import { TopBarControls } from '@app/core/Layout/AppShell/TopBarControls';
import { useIdleReady } from '@app/core/Layout/AppShell/useIdleReady';
import { useScrollEdge } from '@app/core/Layout/AppShell/useScrollEdge';
import { lazy, Suspense } from 'react';

const AccountMenu = lazy(() =>
  import('@app/core/Layout/AppShell/AccountMenu').then((module) => ({
    default: module.AccountMenu,
  })),
);

export const TopBar = () => {
  const isScrolled = useScrollEdge();
  const isDesktop = useIsDesktop();
  const isIdle = useIdleReady();

  return (
    <header className="glass-thin sticky top-0 z-30 pt-[env(safe-area-inset-top)]">
      <PageColumn className="flex h-13 items-center gap-2 lg:h-14 lg:gap-8">
        <Brand />
        <div className="lg:order-1 lg:-ml-6">
          <RealtimeStatusIndicator />
        </div>
        <DesktopNav />
        <TopBarControls />
        <div className="hidden size-9 lg:order-2 lg:-ml-6 lg:block">
          {isDesktop && isIdle && (
            <Suspense fallback={null}>
              <AccountMenu />
            </Suspense>
          )}
        </div>
      </PageColumn>
      <div
        aria-hidden
        data-visible={isScrolled}
        className="pointer-events-none absolute inset-x-0 top-full h-6 bg-linear-to-b from-background/70 to-transparent opacity-0 transition-opacity duration-(--duration-quick) data-[visible=true]:opacity-100"
      />
    </header>
  );
};
