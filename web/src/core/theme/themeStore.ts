import { readPreference, storePreference } from '@app/core/preferenceStorage';
import {
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemePreference,
} from '@app/core/theme/themePreference';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

interface ThemeStore {
  readonly getPreference: () => ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
  readonly resolvedTheme: () => Theme;
  readonly subscribe: (onChange: () => void) => () => void;
}

const systemPrefersDark = (): boolean => window.matchMedia(DARK_SCHEME_QUERY).matches;

export const createThemeStore = (): ThemeStore => {
  let preference = parseThemePreference(readPreference(THEME_STORAGE_KEY));
  const listeners = new Set<() => void>();

  return {
    getPreference: () => preference,
    setPreference: (next) => {
      preference = next;
      storePreference(THEME_STORAGE_KEY, next);
      for (const listener of listeners) {
        listener();
      }
    },
    resolvedTheme: () => resolveTheme(preference, systemPrefersDark()),
    subscribe: (onChange) => {
      const query = window.matchMedia(DARK_SCHEME_QUERY);
      listeners.add(onChange);
      query.addEventListener('change', onChange);
      return () => {
        listeners.delete(onChange);
        query.removeEventListener('change', onChange);
      };
    },
  };
};

export const themeStore = createThemeStore();

// index.html holds one theme-color per system scheme for the first paint: a theme chosen against
// the system scheme would keep the other one's color on the browser chrome.
const syncThemeColorMeta = (): void => {
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue('--background')
    .trim();
  if (background === '') {
    return;
  }
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = background;
  }
};

// HeroUI reads both the `dark` class and `data-theme`; setting only one leaves half of the
// components in the other theme.
const applyTheme = (theme: Theme): void => {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  syncThemeColorMeta();
};

export const syncThemeAttribute = (store: ThemeStore = themeStore): (() => void) => {
  const apply = (): void => applyTheme(store.resolvedTheme());
  apply();
  return store.subscribe(apply);
};
