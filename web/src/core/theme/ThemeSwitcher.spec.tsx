import { ThemeSwitcher } from '@app/core/theme/ThemeSwitcher';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const stubSystemScheme = (prefersDark: boolean): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: prefersDark && query === '(prefers-color-scheme: dark)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
};

const appliedTheme = (): { hasDarkClass: boolean; dataTheme: string | undefined } => ({
  hasDarkClass: document.documentElement.classList.contains('dark'),
  dataTheme: document.documentElement.dataset.theme,
});

describe('ThemeSwitcher', () => {
  it('applies and remembers the chosen theme', async () => {
    stubSystemScheme(false);
    const user = userEvent.setup();
    renderWithProviders(<ThemeSwitcher />);

    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));

    expect(appliedTheme()).toEqual({ hasDarkClass: true, dataTheme: 'dark' });
    expect(window.localStorage.getItem('binsight.theme')).toBe('dark');
  });

  it('follows the system scheme by default', () => {
    stubSystemScheme(true);
    renderWithProviders(<ThemeSwitcher />);

    expect(screen.getByRole('radio', { name: 'System theme' })).toBeChecked();
    expect(appliedTheme()).toEqual({ hasDarkClass: true, dataTheme: 'dark' });
  });
});
