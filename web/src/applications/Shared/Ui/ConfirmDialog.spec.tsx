import { ConfirmDialog } from '@app/applications/Shared/Ui/ConfirmDialog';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const renderConfirm = (onConfirm: () => Promise<boolean>, onOpenChange = vi.fn()) => {
  renderWithProviders(
    <ConfirmDialog
      isOpen
      onOpenChange={onOpenChange}
      title="Remove Main?"
      confirmLabel="Remove"
      onConfirm={onConfirm}
    >
      Its history stays on disk.
    </ConfirmDialog>,
  );
  return onOpenChange;
};

describe('ConfirmDialog', () => {
  it('runs the action, then closes', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => true);
    const onOpenChange = renderConfirm(onConfirm);

    expect(await screen.findByRole('alertdialog', { name: 'Remove Main?' })).toHaveTextContent(
      'Its history stays on disk.',
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open when the action fails', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => false);
    const onOpenChange = renderConfirm(onConfirm);

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('does nothing when cancelled', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => true);
    const onOpenChange = renderConfirm(onConfirm);

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
