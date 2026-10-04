import { ResponsiveDrawer } from '@app/applications/Shared/Layout/Ui/ResponsiveDrawer';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const stubScreen = (isDesktop: boolean): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: isDesktop && query === '(min-width: 64rem)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
};

const openDrawer = (onOpenChange: (isOpen: boolean) => void = () => undefined) =>
  renderWithProviders(
    <ResponsiveDrawer isOpen onOpenChange={onOpenChange} label="WIF/SOL position">
      <p>detail</p>
    </ResponsiveDrawer>,
  );

describe('ResponsiveDrawer', () => {
  it('slides from the right on a desktop', async () => {
    stubScreen(true);
    openDrawer();

    const dialog = await screen.findByRole('dialog', { name: 'WIF/SOL position' });
    expect(dialog).toHaveTextContent('detail');
    expect(document.querySelector('.drawer__content--right')).not.toBeNull();
  });

  it('rises as a sheet with a handle on a phone', async () => {
    stubScreen(false);
    openDrawer();

    await screen.findByRole('dialog', { name: 'WIF/SOL position' });
    expect(document.querySelector('.drawer__content--bottom')).not.toBeNull();
    expect(document.querySelector('.drawer__handle')).not.toBeNull();
  });

  it('closes from a visible button, not only from Escape or the veil', async () => {
    stubScreen(true);
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    openDrawer(onOpenChange);

    await user.click(await screen.findByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
