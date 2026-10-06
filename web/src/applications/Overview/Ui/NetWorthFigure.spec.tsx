import { NetWorthFigure } from '@app/applications/Overview/Ui/NetWorthFigure';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { overviewFixture } from '@test/fixtures/overview';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

describe('NetWorthFigure', () => {
  afterEach(() => displayPreferenceStore.setAmountsHidden(false));

  it('reads the server total and exposes its four server components on a press', async () => {
    const user = userEvent.setup();
    const { net_worth } = overviewFixture();
    renderWithProviders(<NetWorthFigure netWorth={net_worth} layout="stocks" />);
    expect(screen.getByText('100.123')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show net worth breakdown' }));
    const dialog = screen.getByRole('dialog', { name: 'Net worth breakdown' });
    expect(within(dialog).getByText('Liquidity')).toBeInTheDocument();
    expect(within(dialog).getByText('Idle')).toBeInTheDocument();
    expect(within(dialog).getByText('Unclaimed fees')).toBeInTheDocument();
    expect(within(dialog).getByText('Recoverable rent')).toBeInTheDocument();
    expect(within(dialog).getByText('4.000')).toBeInTheDocument();
    expect(within(dialog).getByText('1.000')).toBeInTheDocument();
  });

  it('keeps the lower bound and masks unpriced holdings inside the breakdown', async () => {
    const user = userEvent.setup();
    const { net_worth } = overviewFixture();
    const unpriced = {
      wallet: {
        address: 'test-wallet',
        label: 'Cold',
        color: 'wallet_1' as const,
        links: {
          solscan: 'https://solscan.io/account/test-wallet',
          jupiter_portfolio: 'https://jup.ag/portfolio/test-wallet',
        },
      },
      token: {
        mint: 'token-mint',
        symbol: 'TEST',
        name: null,
        decimals: 6,
        logo: { kind: 'none' as const },
      },
      amount: '789.123456',
    };
    const total = {
      exactness: 'partial' as const,
      value: { amount: '100.123456789', unit: 'sol' as const },
      reasons: [
        {
          code: 'unpriced_token' as const,
          mint: unpriced.token.mint,
          wallet: unpriced.wallet.address,
        },
      ],
    };
    displayPreferenceStore.setAmountsHidden(true);
    renderWithProviders(
      <NetWorthFigure netWorth={{ ...net_worth, total, unpriced: [unpriced] }} layout="compact" />,
    );
    expect(screen.getByRole('button', { name: 'Why a lower bound?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show net worth breakdown' }));
    const dialog = screen.getByRole('dialog', { name: 'Net worth breakdown' });
    expect(within(dialog).getByText('Cold')).toBeInTheDocument();
    expect(
      within(dialog).getByText('These holdings are not included in net worth.'),
    ).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('789.123');
    expect(dialog).toHaveTextContent('•••••');
  });
});
