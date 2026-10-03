import { parseThemePreference, resolveTheme } from '@app/core/theme/themePreference';
import { describe, expect, it } from 'vitest';

describe('parseThemePreference', () => {
  it('keeps a known preference', () => {
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('light')).toBe('light');
  });

  it('falls back to the system preference for anything else', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('sepia')).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('applies an explicit preference whatever the system says', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('follows the system when the preference is "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
