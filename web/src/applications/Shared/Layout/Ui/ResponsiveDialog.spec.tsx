import { ResponsiveDialog } from '@app/applications/Shared/Layout/Ui/ResponsiveDialog';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const stubScreen = (isDesktop: boolean): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: isDesktop && query === '(min-width: 64rem)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
};

describe('ResponsiveDialog', () => {
  for (const isDesktop of [true, false]) {
    it(`shows a titled dialog on a ${isDesktop ? 'desktop' : 'phone'}`, async () => {
      stubScreen(isDesktop);
      renderWithProviders(
        <ResponsiveDialog isOpen onOpenChange={() => undefined} title="Share">
          <p>options</p>
        </ResponsiveDialog>,
      );

      const dialog = await screen.findByRole('dialog', { name: 'Share' });
      expect(dialog).toHaveTextContent('options');
    });
  }
});
