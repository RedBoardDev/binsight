import { KeyFigureList } from '@app/applications/Overview/Ui/OverviewPage/OverviewDesktop/KeyFigureList';
import { completeOverviewAmount, overviewFixture } from '@test/fixtures/overview';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const wallet = {
  address: 'test-wallet',
  label: 'Cold',
  color: 'wallet_1' as const,
  links: {
    solscan: 'https://solscan.io/account/test-wallet',
    jupiter_portfolio: 'https://jup.ag/portfolio/test-wallet',
  },
};

describe('KeyFigureList', () => {
  it('lists net worth, its LP and idle parts, active PnL and gain from the server figures', () => {
    renderWithProviders(<KeyFigureList overview={overviewFixture()} period="3m" />);
    expect(screen.getByText('Net worth')).toBeInTheDocument();
    expect(screen.getByText('100.123')).toBeInTheDocument();
    expect(screen.getByText('LP · idle')).toBeInTheDocument();
    expect(screen.getByText('80.00')).toBeInTheDocument();
    expect(screen.getByText('15.12')).toBeInTheDocument();
    expect(screen.getByText('+1.336')).toBeInTheDocument();
    expect(screen.getByText('+2.50%')).toBeInTheDocument();
    expect(screen.getByText('Gain · 3M')).toBeInTheDocument();
    expect(screen.getByText('+12.553')).toBeInTheDocument();
    expect(screen.getByText('+20.4%')).toBeInTheDocument();
  });

  it('opens no breakdown: net worth is a plain line of the list', () => {
    renderWithProviders(<KeyFigureList overview={overviewFixture()} period="1m" />);
    expect(screen.queryByRole('button', { name: /net worth/i })).not.toBeInTheDocument();
  });

  it('does not infer no open positions from a zero count while history is unavailable', () => {
    const overview = overviewFixture();
    const reasons = [
      { code: 'history_incomplete' as const, wallet: 'test-wallet', progress: null },
    ];
    const unavailable = { exactness: 'unavailable' as const, reasons };
    renderWithProviders(
      <KeyFigureList
        overview={{
          ...overview,
          open: { ...overview.open, count: 0, pnl: unavailable, pnl_pct: unavailable },
        }}
        period="1m"
      />,
    );
    expect(screen.queryByText('No open positions')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Why not available?' })).toHaveLength(2);
    expect(screen.queryByText('0.000')).not.toBeInTheDocument();
  });

  it('shows no open positions when the server supplies a complete zero-position figure', () => {
    const overview = overviewFixture();
    renderWithProviders(
      <KeyFigureList
        overview={{
          ...overview,
          open: {
            ...overview.open,
            count: 0,
            pnl: completeOverviewAmount('0'),
            pnl_pct: { exactness: 'unavailable', reasons: [{ code: 'zero_denominator' }] },
          },
        }}
        period="1m"
      />,
    );
    expect(screen.getByText('No open positions')).toBeInTheDocument();
    expect(screen.getByText('0.000')).toBeInTheDocument();
  });

  it('names the importing wallet under an unavailable gain without a fabricated zero percent', () => {
    const overview = overviewFixture();
    const reasons = [
      { code: 'history_incomplete' as const, wallet: wallet.address, progress: null },
    ];
    renderWithProviders(
      <KeyFigureList
        overview={{
          ...overview,
          sync: { state: 'importing', lagging: [], importing: [{ wallet, progress: null }] },
          gain: {
            ...overview.gain,
            value: { exactness: 'unavailable', reasons },
            pct: { exactness: 'unavailable', reasons },
          },
        }}
        period="1m"
      />,
    );
    expect(screen.getByText('Cold is importing history')).toBeInTheDocument();
    expect(screen.queryByText(/0[.,]0%/)).not.toBeInTheDocument();
    expect(screen.getByText('+1.336')).toBeInTheDocument();
  });
});
