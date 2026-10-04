import {
  expandTabBar,
  followTabBarScroll,
  type ScrollSample,
  startTabBarScroll,
  type TabBarScroll,
} from '@app/core/Layout/AppShell/FloatingTabBar/tabBarScroll';
import { describe, expect, it } from 'vitest';

const scrollThrough = (state: TabBarScroll, samples: readonly ScrollSample[]): TabBarScroll =>
  samples.reduce(followTabBarScroll, state);

const top = startTabBarScroll({ y: 0, atMs: 0 });

describe('the floating tab bar on scroll', () => {
  it('minimizes after a quick scroll down', () => {
    const state = scrollThrough(top, [
      { y: 30, atMs: 50 },
      { y: 80, atMs: 100 },
    ]);

    expect(state.isMinimized).toBe(true);
  });

  it('stays full during a slow scroll down', () => {
    const state = scrollThrough(top, [
      { y: 30, atMs: 1_000 },
      { y: 60, atMs: 2_000 },
      { y: 90, atMs: 3_000 },
    ]);

    expect(state.isMinimized).toBe(false);
  });

  it('stays full for a short scroll down', () => {
    expect(scrollThrough(top, [{ y: 40, atMs: 20 }]).isMinimized).toBe(false);
  });

  it('comes back after a small scroll up', () => {
    const minimized = scrollThrough(top, [{ y: 400, atMs: 100 }]);
    expect(minimized.isMinimized).toBe(true);

    expect(scrollThrough(minimized, [{ y: 395, atMs: 200 }]).isMinimized).toBe(true);
    expect(
      scrollThrough(minimized, [
        { y: 395, atMs: 200 },
        { y: 380, atMs: 300 },
      ]).isMinimized,
    ).toBe(false);
  });

  it('comes back at the top of the page', () => {
    const minimized = scrollThrough(top, [{ y: 60, atMs: 10 }]);

    expect(scrollThrough(minimized, [{ y: 0, atMs: 20 }]).isMinimized).toBe(false);
  });

  it('counts the next scroll down from where a tap brought it back', () => {
    const tapped = expandTabBar(scrollThrough(top, [{ y: 400, atMs: 100 }]));

    expect(tapped.isMinimized).toBe(false);
    expect(scrollThrough(tapped, [{ y: 430, atMs: 110 }]).isMinimized).toBe(false);
    expect(scrollThrough(tapped, [{ y: 460, atMs: 120 }]).isMinimized).toBe(true);
  });
});
