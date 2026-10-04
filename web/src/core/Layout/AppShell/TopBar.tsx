import { Brand } from '@app/core/Layout/AppShell/Brand';
import { DesktopNav } from '@app/core/Layout/AppShell/DesktopNav';
import { PageColumn } from '@app/core/Layout/AppShell/PageColumn';
import { TopBarControls } from '@app/core/Layout/AppShell/TopBarControls';
import { useScrollEdge } from '@app/core/Layout/AppShell/useScrollEdge';

// Thin glass that stays on top of the page. At rest it reads as the page itself; once content
// scrolls under it, a soft fade marks its edge (no hard rule).
export const TopBar = () => {
  const isScrolled = useScrollEdge();

  return (
    <header className="glass-thin sticky top-0 z-30 pt-[env(safe-area-inset-top)]">
      <PageColumn className="flex h-13 items-center gap-2 lg:h-14 lg:gap-8">
        <Brand />
        <DesktopNav />
        <TopBarControls />
      </PageColumn>
      <div
        aria-hidden
        data-visible={isScrolled}
        className="pointer-events-none absolute inset-x-0 top-full h-6 bg-linear-to-b from-background/70 to-transparent opacity-0 transition-opacity duration-(--duration-quick) data-[visible=true]:opacity-100"
      />
    </header>
  );
};
