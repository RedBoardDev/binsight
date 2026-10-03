import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const THEME_INIT_SOURCE = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');

interface Environment {
  readonly storedPreference: string | null | Error;
  readonly systemPrefersDark: boolean;
}

interface AppliedTheme {
  readonly hasDarkClass: boolean;
  readonly dataTheme: string | undefined;
}

const runThemeInit = ({ storedPreference, systemPrefersDark }: Environment): AppliedTheme => {
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  const localStorage = {
    getItem: (key: string): string | null => {
      if (storedPreference instanceof Error) {
        throw storedPreference;
      }
      return key === 'binsight.theme' ? storedPreference : null;
    },
  };
  const window = {
    localStorage,
    matchMedia: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' && systemPrefersDark,
    }),
  };
  const documentElement = {
    dataset,
    classList: {
      toggle: (name: string, force: boolean): void => {
        if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
    },
  };
  runInNewContext(THEME_INIT_SOURCE, { window, document: { documentElement } });
  return { hasDarkClass: classes.has('dark'), dataTheme: dataset.theme };
};

const DARK: AppliedTheme = { hasDarkClass: true, dataTheme: 'dark' };
const LIGHT: AppliedTheme = { hasDarkClass: false, dataTheme: 'light' };

describe('theme-init.js', () => {
  it('applies the stored dark preference on a light system', () => {
    expect(runThemeInit({ storedPreference: 'dark', systemPrefersDark: false })).toEqual(DARK);
  });

  it('applies the stored light preference on a dark system', () => {
    expect(runThemeInit({ storedPreference: 'light', systemPrefersDark: true })).toEqual(LIGHT);
  });

  it('follows the system when the preference is "system" or missing', () => {
    expect(runThemeInit({ storedPreference: 'system', systemPrefersDark: true })).toEqual(DARK);
    expect(runThemeInit({ storedPreference: null, systemPrefersDark: true })).toEqual(DARK);
    expect(runThemeInit({ storedPreference: null, systemPrefersDark: false })).toEqual(LIGHT);
  });

  it('follows the system when the storage cannot be read', () => {
    const blocked = new Error('SecurityError: storage is disabled');
    expect(runThemeInit({ storedPreference: blocked, systemPrefersDark: true })).toEqual(DARK);
  });
});
