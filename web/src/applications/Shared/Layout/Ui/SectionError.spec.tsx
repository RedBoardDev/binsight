import { SectionError } from '@app/applications/Shared/Layout/Ui/SectionError';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

describe('SectionError', () => {
  it('says what failed in its place and tries again on request', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SectionError message="The bridge did not respond." onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('The bridge did not respond.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
