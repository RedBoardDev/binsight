import { TextMenu } from '@app/applications/Shared/Control/Ui/TextMenu';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const OUTCOMES = [
  { id: 'all', label: 'All' },
  { id: 'win', label: 'Win' },
  { id: 'loss', label: 'Loss' },
] as const;

describe('TextMenu', () => {
  it('shows the chosen value and offers the others', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <TextMenu
        label="Outcome"
        options={OUTCOMES}
        selected="all"
        neutral="all"
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole('button', { name: /Outcome/ });
    expect(trigger).toHaveTextContent('OutcomeAll');

    await user.click(trigger);
    await user.click(screen.getByRole('menuitemradio', { name: 'Win' }));

    expect(onChange).toHaveBeenCalledWith('win');
  });
});
