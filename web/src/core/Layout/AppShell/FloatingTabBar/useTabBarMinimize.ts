import {
  expandTabBar,
  followTabBarScroll,
  startTabBarScroll,
} from '@app/core/Layout/AppShell/FloatingTabBar/tabBarScroll';
import { type RefObject, useEffect, useRef, useState } from 'react';

interface TabBarMinimize {
  readonly isMinimized: boolean;
  readonly expand: () => void;
}

const sampleScroll = () => ({ y: window.scrollY, atMs: performance.now() });

// A keyboard user tabbing through the bar would lose the focus to the page when its tabs turn
// inert: the bar stays full while it holds the focus.
const holdsFocus = (bar: RefObject<HTMLElement | null>): boolean =>
  bar.current?.matches(':focus-within') ?? false;

export const useTabBarMinimize = (
  isAllowed: boolean,
  bar: RefObject<HTMLElement | null>,
): TabBarMinimize => {
  const scroll = useRef(startTabBarScroll(sampleScroll()));
  const [isMinimized, setMinimized] = useState(false);

  useEffect(() => {
    if (!isAllowed) {
      setMinimized(false);
      return undefined;
    }
    scroll.current = startTabBarScroll(sampleScroll());
    const onScroll = (): void => {
      const next = followTabBarScroll(scroll.current, sampleScroll());
      scroll.current = next.isMinimized && holdsFocus(bar) ? expandTabBar(next) : next;
      setMinimized(scroll.current.isMinimized);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isAllowed, bar]);

  const expand = (): void => {
    scroll.current = expandTabBar(scroll.current);
    setMinimized(false);
  };

  return { isMinimized, expand };
};
