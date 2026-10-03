import { readPreference, storePreference } from '@app/core/preferenceStorage';
import {
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemePreference,
} from '@app/core/theme/themePreference';
import { useEffect, useState, useSyncExternalStore } from 'react';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

const subscribeToSystemScheme = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(DARK_SCHEME_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

const readSystemPrefersDark = (): boolean => window.matchMedia(DARK_SCHEME_QUERY).matches;

// HeroUI reads both the `dark` class and `data-theme`; setting only one leaves half of the
// components in the other theme.
const applyTheme = (theme: Theme): void => {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
};

interface ThemePreferenceControl {
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

export const useThemePreference = (): ThemePreferenceControl => {
  const [preference, setPreferenceState] = useState(() =>
    parseThemePreference(readPreference(THEME_STORAGE_KEY)),
  );
  const systemPrefersDark = useSyncExternalStore(subscribeToSystemScheme, readSystemPrefersDark);

  useEffect(() => {
    applyTheme(resolveTheme(preference, systemPrefersDark));
  }, [preference, systemPrefersDark]);

  const setPreference = (next: ThemePreference): void => {
    setPreferenceState(next);
    storePreference(THEME_STORAGE_KEY, next);
  };

  return { preference, setPreference };
};
