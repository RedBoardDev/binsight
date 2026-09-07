'use client';

import { type Tab, useUi } from '@app/core/stores/uiStore';
import { cn } from '@heroui/react';
import type { LucideIcon } from 'lucide-react';
import { BarChart3, History, Layers } from 'lucide-react';

const TABS: { label: string; value: Tab; Icon: LucideIcon }[] = [
  { label: 'Positions', value: 'positions', Icon: Layers },
  { label: 'Stats', value: 'stats', Icon: BarChart3 },
  { label: 'History', value: 'history', Icon: History },
];

/** Fixed bottom navigation between the three top-level views, with safe-area inset padding. */
export const MobileTabBar = () => {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-border border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
      <div className="flex">
        {TABS.map(({ label, value, Icon }) => {
          const active = tab === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-12 flex-1 flex-col items-center gap-1 py-2.5 font-medium text-[11px] transition-colors',
                active ? 'text-accent' : 'text-muted active:text-foreground',
              )}
            >
              <Icon size={20} strokeWidth={active ? 2.25 : 1.75} />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
