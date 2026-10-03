export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type Theme = 'light' | 'dark';

// public/theme-init.js reads the same key before the first paint; test/themeInit.spec.ts keeps
// the two in step.
export const THEME_STORAGE_KEY = 'binsight.theme';

export const isThemePreference = (value: unknown): value is ThemePreference =>
  typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);

export const parseThemePreference = (stored: string | null): ThemePreference =>
  isThemePreference(stored) ? stored : 'system';

export const resolveTheme = (preference: ThemePreference, systemPrefersDark: boolean): Theme => {
  if (preference !== 'system') {
    return preference;
  }
  return systemPrefersDark ? 'dark' : 'light';
};
