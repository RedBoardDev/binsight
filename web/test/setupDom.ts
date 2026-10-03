import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
