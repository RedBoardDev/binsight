import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Figure, MoneyUnit } from '@app/applications/Shared/Figure/Domain/figure';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const money = (amount: string, unit: MoneyUnit = 'sol') => {
  const parsed = parseDecimalString(amount);
  if (parsed === null) {
    throw new Error(`${amount} is not a decimal string`);
  }
  return { amount: parsed, unit };
};

const complete = (amount: string, unit: MoneyUnit = 'sol'): Figure => ({
  exactness: 'complete',
  value: money(amount, unit),
});

describe('FigureAmount', () => {
  afterEach(() => displayPreferenceStore.setAmountsHidden(false));

  it('shows a signed amount in its tone, with the Solana mark, and says it in words', () => {
    const { container } = renderWithProviders(
      <FigureAmount figure={complete('0.4215')} placement="hero" signing="always" />,
    );

    expect(screen.getByText('+0.422')).toHaveClass('text-gain');
    expect(container.querySelector('use')).toHaveAttribute('href', '#solana-mark');
    expect(screen.getByText('plus 0.422 SOL')).toHaveClass('sr-only');
  });

  it('shows a loss with a true minus', () => {
    renderWithProviders(
      <FigureAmount figure={complete('-0.949')} placement="key" signing="always" />,
    );

    expect(screen.getByText('−0.949')).toHaveClass('text-loss');
  });

  it('marks a lower bound and explains it', () => {
    const figure: Figure = {
      exactness: 'partial',
      value: money('61.54'),
      reasons: [{ code: 'unpriced_leg', position: 'position-address' }],
    };
    renderWithProviders(<FigureAmount figure={figure} placement="key" signing="negative-only" />);

    expect(screen.getByText('≥')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Why a lower bound?' })).toBeInTheDocument();
    expect(screen.getByText('61.540 SOL, lower bound')).toBeInTheDocument();
  });

  it('shows a dash, never a zero, when the figure is unavailable', () => {
    const figure: Figure = {
      exactness: 'unavailable',
      reasons: [{ code: 'zero_denominator' }],
    };
    renderWithProviders(<FigureAmount figure={figure} placement="key" signing="always" />);

    expect(screen.getByRole('button', { name: 'Why not available?' })).toHaveTextContent('—');
  });

  it('keeps unavailable quality explicit without an interactive trigger in a static reading', () => {
    renderWithProviders(
      <FigureAmount
        figure={{ exactness: 'unavailable', reasons: [{ code: 'zero_denominator' }] }}
        placement="body"
        signing="always"
        reasonDisplay="static"
      />,
    );
    expect(screen.getByText('Not available')).toHaveClass('sr-only');
    expect(screen.getByText('—')).toHaveAttribute('aria-hidden');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the estimate and its amount accessible without a static tab stop', () => {
    renderWithProviders(
      <FigureAmount
        figure={{
          exactness: 'estimated',
          value: money('1.5'),
          reasons: [
            { code: 'reconstructed_history', wallet: 'test-wallet', until: '2026-10-01T00:00:00Z' },
          ],
        }}
        placement="body"
        signing="always"
        reasonDisplay="static"
      />,
    );
    expect(screen.getByText('Estimated')).toBeInTheDocument();
    expect(screen.getByText('plus 1.500 SOL, estimated')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('hides the digits but keeps the sign and the tone', () => {
    displayPreferenceStore.setAmountsHidden(true);
    renderWithProviders(
      <FigureAmount figure={complete('-1.5')} placement="key" signing="always" />,
    );

    expect(screen.getByText('−•••••')).toHaveClass('text-loss');
    expect(screen.getByText('minus amount hidden SOL')).toBeInTheDocument();
  });

  it('prefixes dollars and draws no Solana mark', () => {
    const { container } = renderWithProviders(
      <FigureAmount figure={complete('12.5', 'usd')} placement="key" signing="always" />,
    );

    expect(screen.getByText('+$12.50')).toBeInTheDocument();
    expect(container.querySelector('use')).toBeNull();
  });

  it('keeps the dollar sign of a hidden amount, and says its unit', () => {
    displayPreferenceStore.setAmountsHidden(true);
    renderWithProviders(
      <FigureAmount figure={complete('12.5', 'usd')} placement="key" signing="always" />,
    );

    expect(screen.getByText('+$•••••')).toHaveClass('text-gain');
    expect(screen.getByText('plus amount hidden USD')).toBeInTheDocument();
  });
});
