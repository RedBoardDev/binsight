import { LocaleSwitcher } from '@app/core/i18n/LocaleSwitcher';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

describe('LocaleSwitcher', () => {
  it('switches the interface to the chosen language and remembers it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LocaleSwitcher />);

    await user.click(screen.getByRole('button', { name: /Language/ }));
    await user.click(await screen.findByRole('option', { name: 'Français' }));

    await waitFor(() => expect(screen.getByText('Langue')).toBeInTheDocument());
    expect(document.documentElement.lang).toBe('fr-FR');
    expect(window.localStorage.getItem('binsight.locale')).toBe('fr');
  });
});
