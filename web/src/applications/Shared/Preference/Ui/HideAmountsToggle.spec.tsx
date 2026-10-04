import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { HideAmountsToggle } from '@app/applications/Shared/Preference/Ui/HideAmountsToggle';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

describe('HideAmountsToggle', () => {
  afterEach(() => displayPreferenceStore.setAmountsHidden(false));

  it('hides the amounts, and remembers it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HideAmountsToggle />);
    const toggle = screen.getByRole('button', { name: 'Hide amounts' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(displayPreferenceStore.getSnapshot().areAmountsHidden).toBe(true);
    expect(window.localStorage.getItem('binsight.hideAmounts')).toBe('true');
  });
});
