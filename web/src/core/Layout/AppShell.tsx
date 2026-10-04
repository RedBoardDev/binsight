import { RealtimeProvider } from '@app/applications/Realtime/Ui/RealtimeProvider';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { useGlobalShortcuts } from '@app/core/Shortcut/useGlobalShortcuts';
import { Outlet, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { FloatingTabBar } from './AppShell/FloatingTabBar';
import { PageColumn } from './AppShell/PageColumn';
import { MAIN_CONTENT_ID, SkipLink } from './AppShell/SkipLink';
import { TopBar } from './AppShell/TopBar';

// The document itself scrolls, under a translucent top bar; on a phone, the floating tab bar sits
// above the page and the page leaves room for it at its bottom. Only the content has a view
// transition name: a page change cross-fades it while the bars stay still (motion.css).
export const AppShell = () => {
  const router = useRouter();
  // A screen reader is told nothing when only the content changes: the focus moves to the new
  // page's title, which it then reads. preventScroll leaves the scroll to its restoration.
  useEffect(
    () =>
      router.subscribe('onResolved', ({ pathChanged }) => {
        if (pathChanged) {
          document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
        }
      }),
    [router],
  );
  useGlobalShortcuts({
    'toggle-currency': displayPreferenceStore.toggleCurrency,
    'toggle-hidden-amounts': displayPreferenceStore.toggleAmountsHidden,
  });

  return (
    <RealtimeProvider>
      <SkipLink />
      <TopBar />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="pt-6 pb-(--tab-bar-clearance) outline-none [view-transition-name:page] lg:pt-10 lg:pb-24"
      >
        <PageColumn>
          <Outlet />
        </PageColumn>
      </main>
      <FloatingTabBar />
    </RealtimeProvider>
  );
};
