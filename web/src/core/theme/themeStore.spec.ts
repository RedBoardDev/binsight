// @vitest-environment jsdom
import { createThemeStore, syncThemeAttribute } from '@app/core/theme/themeStore';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A system scheme that the test can switch, like macOS or iOS at sunset.
const stubSwitchableSystemScheme = (prefersDark: boolean): ((prefersDark: boolean) => void) => {
  let isDark = prefersDark;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return isDark && query === '(prefers-color-scheme: dark)';
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next) => {
    isDark = next;
    for (const listener of listeners) {
      listener();
    }
  };
};

const appliedTheme = (): string | undefined => document.documentElement.dataset.theme;

const themeColors = (): string[] =>
  [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
    (meta) => meta.content,
  );

describe('the theme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
    window.localStorage.clear();
  });

  it('follows the system scheme while the page is open', () => {
    const switchSystemScheme = stubSwitchableSystemScheme(false);
    const stop = syncThemeAttribute(createThemeStore());
    expect(appliedTheme()).toBe('light');

    switchSystemScheme(true);

    expect(appliedTheme()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    stop();
  });

  it('keeps a chosen theme when the system scheme changes', () => {
    const switchSystemScheme = stubSwitchableSystemScheme(false);
    const store = createThemeStore();
    const stop = syncThemeAttribute(store);

    store.setPreference('dark');
    switchSystemScheme(false);

    expect(appliedTheme()).toBe('dark');
    expect(window.localStorage.getItem('binsight.theme')).toBe('dark');
    stop();
  });

  it('colors the browser chrome with the applied theme, even against the system scheme', () => {
    stubSwitchableSystemScheme(false);
    document.head.innerHTML =
      '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#000">' +
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000">';
    document.documentElement.style.setProperty('--background', '#0b0f17');
    const store = createThemeStore();
    const stop = syncThemeAttribute(store);

    store.setPreference('dark');

    expect(themeColors()).toEqual(['#0b0f17', '#0b0f17']);
    document.documentElement.style.removeProperty('--background');
    stop();
  });
});
