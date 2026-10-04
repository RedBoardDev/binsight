import { useIsDesktop } from '@app/applications/Shared/Layout/Ui/useIsDesktop';
import { useReducedMotion } from '@app/applications/Shared/Motion/Ui/useReducedMotion';
import {
  activeTabFor,
  MORE_TAB,
  TAB_BAR_PAGES,
  type TabBarTab,
} from '@app/core/Layout/AppShell/navItems';
import { useIdleReady } from '@app/core/Layout/AppShell/useIdleReady';
import { useLingui } from '@lingui/react/macro';
import { useRouterState } from '@tanstack/react-router';
import { type CSSProperties, lazy, Suspense, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { TabBarButton, TabBarLink } from './FloatingTabBar/TabBarItem';
import { useKeyboardOpen } from './FloatingTabBar/useKeyboardOpen';
import { useTabBarMinimize } from './FloatingTabBar/useTabBarMinimize';

const MoreSheet = lazy(() =>
  import('@app/core/Layout/AppShell/MoreSheet').then((module) => ({ default: module.MoreSheet })),
);

const TAB_ORDER: readonly TabBarTab[] = [...TAB_BAR_PAGES.map((page) => page.path), 'more'];

export const FloatingTabBar = () => {
  const { i18n, t } = useLingui();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTab = activeTabFor(pathname);
  const isReducedMotion = useReducedMotion();
  const barRef = useRef<HTMLElement>(null);
  const { isMinimized, expand } = useTabBarMinimize(!isReducedMotion, barRef);
  const isKeyboardOpen = useKeyboardOpen();
  const [isMoreOpen, setMoreOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const isIdle = useIdleReady();
  const activePage = TAB_BAR_PAGES.find((page) => page.path === activeTab);
  const ActiveIcon = activePage?.Icon ?? MORE_TAB.Icon;
  const lensStyle = { '--tab-index': TAB_ORDER.indexOf(activeTab ?? 'more') } as CSSProperties;
  const scrollToTop = (): void =>
    window.scrollTo({ top: 0, behavior: isReducedMotion ? 'auto' : 'smooth' });

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 h-(--tab-bar-clearance) bg-linear-to-t from-background/70 to-transparent lg:hidden"
      />
      <nav
        ref={barRef}
        aria-label={t`Main`}
        hidden={isKeyboardOpen}
        data-minimized={isMinimized}
        className="group/bar pointer-events-none fixed right-(--gutter-right) bottom-(--tab-bar-bottom) left-(--gutter-left) z-40 mx-auto h-(--tab-bar-height) max-w-110 lg:hidden"
      >
        <div
          inert={isMinimized}
          className="glass-thick group/capsule pointer-events-auto absolute bottom-0 left-0 h-16 w-full origin-bottom-left overflow-hidden rounded-full transition-[opacity,scale] duration-(--duration-spring-default) ease-settle group-data-[minimized=true]/bar:pointer-events-none group-data-[minimized=true]/bar:scale-90 group-data-[minimized=true]/bar:opacity-0"
        >
          <div className="relative flex h-full items-center p-1">
            <span
              aria-hidden
              style={lensStyle}
              data-visible={activeTab !== null}
              className="absolute top-1 left-1 h-14 w-[calc((100%-0.5rem)/4)] translate-x-[calc(var(--tab-index)*100%)] rounded-full bg-foreground/9 opacity-0 shadow-(--glass-highlight) transition-[translate,scale,opacity] duration-(--duration-spring-lens) ease-lens group-has-[:active]/capsule:scale-(--lens-press-scale) data-[visible=true]:opacity-100"
            />
            {TAB_BAR_PAGES.map(({ path, label, Icon }) => (
              <TabBarLink
                key={path}
                href={path}
                isCurrent={activeTab === path}
                onPressCurrent={scrollToTop}
                Icon={Icon}
                label={i18n._(label)}
              />
            ))}
            <TabBarButton
              isCurrent={activeTab === 'more'}
              onPress={() => setMoreOpen(true)}
              Icon={MORE_TAB.Icon}
              label={i18n._(MORE_TAB.label)}
            />
          </div>
        </div>
        {isMinimized && (
          <Button
            aria-label={t`Show the tabs`}
            onPress={expand}
            className="glass-thick pointer-events-auto absolute bottom-0 left-0 grid size-13 place-items-center rounded-full text-accent outline-none transition-[opacity,scale] duration-(--duration-spring-default) ease-settle data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus starting:scale-90 starting:opacity-0"
          >
            <ActiveIcon aria-hidden strokeWidth={1.75} className="size-5.5" />
          </Button>
        )}
      </nav>
      {(isMoreOpen || (isIdle && !isDesktop)) && (
        <Suspense fallback={null}>
          <MoreSheet isOpen={isMoreOpen} onOpenChange={setMoreOpen} />
        </Suspense>
      )}
    </>
  );
};
