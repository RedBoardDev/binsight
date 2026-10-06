import { TodayHero } from '@app/applications/Overview/Ui/OverviewPage/OverviewDesktop/TodayHero';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { completeOverviewAmount, overviewFixture } from '@test/fixtures/overview';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

describe('TodayHero', () => {
  afterEach(() => displayPreferenceStore.setAmountsHidden(false));

  it('formats the original server PnL without rounding a floating point copy', () => {
    const { today, freshness } = overviewFixture();
    renderWithProviders(
      <TodayHero today={today} freshness={freshness} historyHref="/history?day=2026-10-06" />,
    );
    expect(screen.getByText('+1.000')).toBeInTheDocument();
    expect(screen.getByText('+2.6%')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /5 closes.*3 wins.*2 losses.*realized/ }),
    ).toHaveAttribute('href', '/history?day=2026-10-06');
  });

  it('hides monetary readings from visible and spoken text while retaining the percent', () => {
    const { today, freshness } = overviewFixture();
    displayPreferenceStore.setAmountsHidden(true);
    renderWithProviders(<TodayHero today={today} freshness={freshness} historyHref="/history" />);
    expect(screen.queryByText('+1.000')).not.toBeInTheDocument();
    expect(screen.getByText('plus amount hidden SOL')).toBeInTheDocument();
    expect(screen.getByText('+2.6%')).toBeInTheDocument();
  });

  it('keeps unavailable history as a dash instead of inventing zero', () => {
    const { today, freshness } = overviewFixture();
    const reasons = [
      { code: 'history_incomplete' as const, wallet: 'test-wallet', progress: null },
    ];
    renderWithProviders(
      <TodayHero
        today={{
          ...today,
          totals: {
            ...today.totals,
            pnl: { exactness: 'unavailable', reasons },
            pnl_pct: { exactness: 'unavailable', reasons },
          },
        }}
        freshness={freshness}
        historyHref="/history"
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Why not available?' })).toHaveLength(2);
    expect(screen.queryByText('0.000')).not.toBeInTheDocument();
  });
  it.each([
    { progress: '32.5', certainty: 'known' },
    { progress: null, certainty: 'unknown' },
  ])(
    'does not infer no closes from a zero count during an import with $certainty progress',
    ({ progress }) => {
      const { today, freshness } = overviewFixture();
      const reasons = [{ code: 'history_incomplete' as const, wallet: 'test-wallet', progress }];
      renderWithProviders(
        <TodayHero
          today={{
            ...today,
            totals: {
              ...today.totals,
              count: 0,
              wins: 0,
              losses: 0,
              flat: 0,
              unknown: 0,
              pnl: { exactness: 'unavailable', reasons },
              pnl_pct: { exactness: 'unavailable', reasons },
            },
          }}
          freshness={freshness}
          historyHref="/history?day=2026-10-06"
        />,
      );
      expect(screen.queryByText('Nothing closed yet today')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /0 closes/ })).not.toBeInTheDocument();
      expect(screen.getByText(/History still importing/)).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Why not available?' })).toHaveLength(2);
      expect(screen.queryByText('0.000')).not.toBeInTheDocument();
      expect(screen.queryByText(/0[.,]0%/)).not.toBeInTheDocument();
      if (progress !== null) expect(screen.getByText(/32[.,]5%/)).toBeInTheDocument();
    },
  );

  it('shows no closes only when the server supplies a complete zero-day figure', () => {
    const { today, freshness } = overviewFixture();
    renderWithProviders(
      <TodayHero
        today={{
          ...today,
          totals: {
            ...today.totals,
            count: 0,
            wins: 0,
            losses: 0,
            flat: 0,
            unknown: 0,
            pnl: completeOverviewAmount('0'),
            pnl_pct: { exactness: 'unavailable', reasons: [{ code: 'zero_denominator' }] },
          },
        }}
        freshness={freshness}
        historyHref="/history"
      />,
    );
    expect(screen.getByText('Nothing closed yet today')).toBeInTheDocument();
    expect(screen.getByText('0.000')).toBeInTheDocument();
  });
});
