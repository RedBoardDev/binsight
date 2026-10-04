import { CurrencyToggle } from '@app/applications/Shared/Preference/Ui/CurrencyToggle';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

describe('CurrencyToggle', () => {
  afterEach(() => displayPreferenceStore.setCurrency('sol'));

  it('shows amounts in SOL by default', () => {
    renderWithProviders(<CurrencyToggle />);

    expect(screen.getByRole('radio', { name: 'Amounts in SOL' })).toBeChecked();
  });

  it('switches every amount to dollars, and remembers it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CurrencyToggle />);

    await user.click(screen.getByRole('radio', { name: 'Amounts in dollars' }));

    expect(displayPreferenceStore.getSnapshot().currency).toBe('usd');
    expect(window.localStorage.getItem('binsight.currency')).toBe('usd');
    expect(screen.getByRole('radio', { name: 'Amounts in dollars' })).toBeChecked();
  });
});
