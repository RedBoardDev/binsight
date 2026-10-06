import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const value = parseDecimalString('-2.41');
if (value === null) throw new Error('A percent test needs a canonical decimal');
const figure = { exactness: 'complete' as const, value };

describe('PercentValue', () => {
  it('inherits a neutral readout tone while retaining its signed percentage', () => {
    renderWithProviders(
      <PercentValue figure={figure} placement="cell" signing="always" tone="neutral" />,
    );
    expect(screen.getByText('−2.41%')).not.toHaveClass('text-loss');
  });

  it('announces unavailable quality without a button in a static percent reading', () => {
    renderWithProviders(
      <PercentValue
        figure={{ exactness: 'unavailable', reasons: [{ code: 'zero_denominator' }] }}
        placement="cell"
        signing="always"
        reasonDisplay="static"
      />,
    );
    expect(screen.getByText('Not available')).toHaveClass('sr-only');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the signed tone when no neutral presentation is requested', () => {
    renderWithProviders(<PercentValue figure={figure} placement="cell" signing="always" />);
    expect(screen.getByText('−2.41%')).toHaveClass('text-loss');
  });
});
