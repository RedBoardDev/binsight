import { PerformancePair } from '@app/applications/Overview/Ui/PerformancePair';
import { completeOverviewAmount, overviewFixture } from '@test/fixtures/overview';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('PerformancePair', () => {
  it('does not infer no open positions from a zero count while history is unavailable', () => {
    const overview = overviewFixture();
    const reasons = [
      { code: 'history_incomplete' as const, wallet: 'test-wallet', progress: null },
    ];
    const unavailable = { exactness: 'unavailable' as const, reasons };
    renderWithProviders(
      <PerformancePair
        overview={{
          ...overview,
          open: { ...overview.open, count: 0, pnl: unavailable, pnl_pct: unavailable },
        }}
        period="1m"
        layout="compact"
      />,
    );
    expect(screen.queryByText('No open positions')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Why not available?' })).toHaveLength(2);
    expect(screen.queryByText('0.000')).not.toBeInTheDocument();
  });

  it('shows no open positions when the server supplies a complete zero-position figure', () => {
    const overview = overviewFixture();
    renderWithProviders(
      <PerformancePair
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
        layout="compact"
      />,
    );
    expect(screen.getByText('No open positions')).toBeInTheDocument();
    expect(screen.getByText('0.000')).toBeInTheDocument();
  });
  it('displays active PnL and gain from their respective server figures', () => {
    renderWithProviders(
      <PerformancePair overview={overviewFixture()} period="1m" layout="stocks" />,
    );
    expect(screen.getByText('+1.336')).toBeInTheDocument();
    expect(screen.getByText('+2.50%')).toBeInTheDocument();
    expect(screen.getByText('+12.553')).toBeInTheDocument();
    expect(screen.getByText('+20.40%')).toBeInTheDocument();
  });

  it('announces unknown import progress without displaying a fabricated zero percent', () => {
    const overview = overviewFixture();
    const wallet = {
      address: 'test-wallet',
      label: 'Cold',
      color: 'wallet_1' as const,
      links: {
        solscan: 'https://solscan.io/account/test-wallet',
        jupiter_portfolio: 'https://jup.ag/portfolio/test-wallet',
      },
    };
    const reasons = [
      { code: 'history_incomplete' as const, wallet: wallet.address, progress: null },
    ];
    const importing = {
      ...overview,
      sync: { state: 'importing' as const, lagging: [], importing: [{ wallet, progress: null }] },
      gain: {
        ...overview.gain,
        value: { exactness: 'unavailable' as const, reasons },
        pct: { exactness: 'unavailable' as const, reasons },
      },
    };
    renderWithProviders(<PerformancePair overview={importing} period="1m" layout="compact" />);
    expect(screen.getByText('Cold is importing history')).toBeInTheDocument();
    expect(screen.queryByText(/0[.,]0%/)).not.toBeInTheDocument();
    expect(screen.getByText('+1.336')).toBeInTheDocument();
  });
});
