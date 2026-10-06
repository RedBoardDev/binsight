import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy* and waitFor give up after one second by default. A spec that renders the whole app
// passes the session guard and several stubbed reads before its first screen; on a host that
// shares its cores with builds, that took more than a second, and the overview chart specs failed
// now and then for being slow, not wrong. Like the test deadline (vitest.config.ts), this is a
// deadline, not a retry: a screen that never appears still fails, with its DOM, before the test's
// own deadline.
configure({ asyncUtilTimeout: 15_000 });

// Without Vitest globals, Testing Library cannot register its own cleanup: rendered trees would
// leak from one test into the next.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// jsdom has no matchMedia. Defined here rather than with vi.stubGlobal, which unstubGlobals would
// remove after the first test; a spec that needs a matching query stubs it itself.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// jsdom does not implement scrolling; the router restores the scroll position on navigation.
window.scrollTo = () => undefined;

// jsdom has no ResizeObserver; HeroUI's toasts measure themselves with one.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver = ResizeObserverStub;

// jsdom has no EventSource. This one never connects; a spec that drives the live stream stubs
// its own with vi.stubGlobal.
class SilentEventSource extends EventTarget {
  readonly CLOSED = 2;
  readyState = 0;

  close(): void {
    this.readyState = this.CLOSED;
  }
}
Object.defineProperty(window, 'EventSource', {
  configurable: true,
  writable: true,
  value: SilentEventSource,
});

// jsdom has no Web Animations API; react-aria's selection indicators (a gliding pill) ask an
// element for its running animations. None run in jsdom.
if (typeof Element.prototype.getAnimations !== 'function') {
  Element.prototype.getAnimations = () => [];
}
