import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  ChartColumn,
  Ellipsis,
  Gauge,
  History,
  LayoutGrid,
  LogOut,
  type LucideIcon,
  Settings,
  Wallet,
} from 'lucide-react';

export type PagePath = '/' | '/history' | '/stats' | '/wallets' | '/health' | '/settings';

export interface PageLink {
  readonly path: PagePath;
  readonly label: MessageDescriptor;
  readonly Icon: LucideIcon;
}

const OVERVIEW: PageLink = { path: '/', label: msg`Overview`, Icon: LayoutGrid };
const HISTORY: PageLink = { path: '/history', label: msg`History`, Icon: History };
const STATS: PageLink = { path: '/stats', label: msg`Stats`, Icon: ChartColumn };
const WALLETS: PageLink = { path: '/wallets', label: msg`Wallets`, Icon: Wallet };
const HEALTH: PageLink = { path: '/health', label: msg`Health`, Icon: Gauge };
const SETTINGS: PageLink = { path: '/settings', label: msg`Settings`, Icon: Settings };

export const TOP_BAR_PAGES: readonly PageLink[] = [OVERVIEW, HISTORY, STATS, WALLETS];
export const ACCOUNT_MENU_PAGES: readonly PageLink[] = [SETTINGS, HEALTH];

export const TAB_BAR_PAGES: readonly PageLink[] = [OVERVIEW, HISTORY, STATS];
export const MORE_PAGES: readonly PageLink[] = [WALLETS, HEALTH, SETTINGS];
export const MORE_TAB = { label: msg`More`, Icon: Ellipsis } as const;

export const SIGN_OUT = { key: 'sign-out', label: msg`Sign out`, Icon: LogOut } as const;

export type TabBarTab = PagePath | 'more';

export const activeTabFor = (pathname: string): TabBarTab | null => {
  const tab = TAB_BAR_PAGES.find((page) => page.path === pathname);
  if (tab !== undefined) {
    return tab.path;
  }
  return MORE_PAGES.some((page) => page.path === pathname) ? 'more' : null;
};
