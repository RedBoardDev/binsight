import { RealtimeProvider } from '@app/applications/Realtime/Ui/RealtimeProvider';
import { Outlet } from '@tanstack/react-router';
import { AppHeader } from './AppShell/AppHeader';
import { DesktopSidebar } from './AppShell/DesktopSidebar';
import { MobileTabBar } from './AppShell/MobileTabBar';

// The sidebar shows from `md:` (width >= 48rem) and the tab bar hides from `md:` too: one
// breakpoint for both, so no width shows both menus or neither. Never pair `md:` with a hand-written
// `max-width: 768px`: at exactly 768px both would hide.
export const AppShell = () => (
  <RealtimeProvider>
    <div className="flex h-full">
      <DesktopSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
        <MobileTabBar />
      </div>
    </div>
  </RealtimeProvider>
);
