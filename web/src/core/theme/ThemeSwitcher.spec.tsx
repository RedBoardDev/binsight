import { ThemeSwitcher } from '@app/core/theme/ThemeSwitcher';
import { syncThemeAttribute, themeStore } from '@app/core/theme/themeStore';
import { renderWithProviders } from '@test/renderWithProviders';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

describe('ThemeSwitcher', () => {
  afterEach(() => themeStore.setPreference('system'));

  it('applies and remembers the chosen theme', async () => {
    const stop = syncThemeAttribute();
    const user = userEvent.setup();
    renderWithProviders(<ThemeSwitcher />);

    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('binsight.theme')).toBe('dark');
    stop();
  });

  it('follows the system scheme by default', () => {
    renderWithProviders(<ThemeSwitcher />);

    expect(screen.getByRole('radio', { name: 'System theme' })).toBeChecked();
  });

  it('shows a choice made elsewhere', () => {
    renderWithProviders(<ThemeSwitcher />);

    act(() => themeStore.setPreference('light'));

    expect(screen.getByRole('radio', { name: 'Light theme' })).toBeChecked();
  });
});
