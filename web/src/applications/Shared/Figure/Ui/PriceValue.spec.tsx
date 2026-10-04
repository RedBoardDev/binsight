import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { PriceValue } from '@app/applications/Shared/Figure/Ui/PriceValue';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const price = (amount: string) => {
  const parsed = parseDecimalString(amount);
  if (parsed === null) {
    throw new Error(`${amount} is not a decimal string`);
  }
  return { amount: parsed, quote: 'sol' as const };
};

describe('PriceValue', () => {
  it('counts the zeros of a tiny price in a subscript, and says the whole number', () => {
    const { container } = renderWithProviders(<PriceValue price={price('0.0000221')} />);

    expect(container.querySelector('sub')).toHaveTextContent('4');
    expect(screen.getByText('0.00002210')).toHaveClass('sr-only');
  });

  it('writes an ordinary price as it is', () => {
    renderWithProviders(<PriceValue price={price('148.2149')} />);

    expect(screen.getByText('148.2')).toBeInTheDocument();
  });
});
