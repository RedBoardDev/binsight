export interface ScrollSample {
  readonly y: number;
  readonly atMs: number;
}

type ScrollDirection = 'up' | 'down';

export interface TabBarScroll {
  readonly isMinimized: boolean;
  readonly direction: ScrollDirection;
  // Where the current direction of scrolling began.
  readonly anchorY: number;
  readonly last: ScrollSample;
}

const MINIMIZE_AFTER_PX = 48;
const MINIMIZE_ABOVE_PX_PER_S = 300;
const EXPAND_AFTER_PX = 12;
const MS_PER_S = 1_000;

export const startTabBarScroll = (sample: ScrollSample): TabBarScroll => ({
  isMinimized: false,
  direction: 'down',
  anchorY: sample.y,
  last: sample,
});

export const followTabBarScroll = (state: TabBarScroll, sample: ScrollSample): TabBarScroll => {
  const delta = sample.y - state.last.y;
  if (delta === 0) {
    return state;
  }
  const direction: ScrollDirection = delta > 0 ? 'down' : 'up';
  const anchorY = direction === state.direction ? state.anchorY : state.last.y;
  const elapsedMs = Math.max(sample.atMs - state.last.atMs, 1);
  const speed = (Math.abs(delta) / elapsedMs) * MS_PER_S;
  const next: TabBarScroll = { ...state, direction, anchorY, last: sample };
  if (sample.y <= 0) {
    return { ...next, isMinimized: false };
  }
  if (
    direction === 'down' &&
    sample.y - anchorY > MINIMIZE_AFTER_PX &&
    speed > MINIMIZE_ABOVE_PX_PER_S
  ) {
    return { ...next, isMinimized: true };
  }
  if (direction === 'up' && anchorY - sample.y > EXPAND_AFTER_PX) {
    return { ...next, isMinimized: false };
  }
  return next;
};

// Brought back by a tap on the disc: the next scroll down starts counting from here.
export const expandTabBar = (state: TabBarScroll): TabBarScroll => ({
  ...state,
  isMinimized: false,
  anchorY: state.last.y,
});
