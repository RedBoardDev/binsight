import { CopyButton } from '@app/applications/Shared/Ui/CopyButton';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

describe('CopyButton', () => {
  it('copies the value and says so', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderWithProviders(
      <CopyButton value="https://binsight.example/positions/a" label="Copy the link" />,
    );

    await user.click(screen.getByRole('button', { name: 'Copy the link' }));

    expect(writeText).toHaveBeenCalledWith('https://binsight.example/positions/a');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('says when the clipboard refuses', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderWithProviders(<CopyButton value="a" label="Copy the link" />);

    await user.click(screen.getByRole('button', { name: 'Copy the link' }));

    expect(
      await screen.findByText('Copy failed: select the text and copy it.'),
    ).toBeInTheDocument();
  });
});
