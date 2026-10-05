import { Sparkline } from '@app/applications/Shared/Chart/Ui/Sparkline';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';
import { renderWithProviders } from '@test/renderWithProviders';
import { describe, expect, it } from 'vitest';

const money = (amount: string): Extract<Figure, { exactness: 'complete' }> => {
  const parsed = parseDecimalString(amount);
  if (parsed === null) throw new Error('A test needs a canonical amount');
  return { exactness: 'complete', value: { amount: parsed, unit: 'sol' } };
};

describe('Sparkline', () => {
  it('draws a 22 pixel decorative curve without an area and keeps estimated segments dashed', () => {
    const estimated: Figure = { ...money('2'), exactness: 'estimated', reasons: [] };
    const { container } = renderWithProviders(<Sparkline values={[money('1'), estimated]} />);
    expect(container.querySelector('svg[focusable="false"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(container.querySelector('svg[focusable="false"]')).toHaveStyle({ height: '22px' });
    expect(container.querySelector('svg[focusable="false"] path')).toHaveAttribute('fill', 'none');
    expect(container.querySelector('svg[focusable="false"] path')).toHaveAttribute(
      'stroke-width',
      '1.25',
    );
    expect(container.querySelector('svg[focusable="false"] path')).toHaveAttribute(
      'stroke-dasharray',
      '4 4',
    );
    expect(container.querySelector('svg[focusable="false"] circle')).toHaveAttribute(
      'fill',
      'var(--foreground)',
    );
  });

  it('cuts unavailable gaps and does not mark the last available value as current', () => {
    const unavailable: Figure = { exactness: 'unavailable', reasons: [] };
    const { container } = renderWithProviders(
      <Sparkline values={[money('1'), unavailable, money('2'), unavailable]} height={48} />,
    );
    expect(container.querySelectorAll('svg[focusable="false"] path')).toHaveLength(2);
    expect(container.querySelector('svg[focusable="false"] circle')).toBeNull();
    expect(container.querySelector('svg[focusable="false"]')).toHaveStyle({ height: '48px' });
  });
});
