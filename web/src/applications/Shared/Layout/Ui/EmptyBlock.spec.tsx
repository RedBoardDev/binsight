import { EmptyBlock } from '@app/applications/Shared/Layout/Ui/EmptyBlock';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('EmptyBlock', () => {
  it('says there is nothing yet and offers the next step', () => {
    renderWithProviders(
      <EmptyBlock message="No open positions." action={<a href="/wallets">Track a wallet</a>} />,
    );

    expect(screen.getByText('No open positions.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Track a wallet' })).toBeInTheDocument();
  });
});
