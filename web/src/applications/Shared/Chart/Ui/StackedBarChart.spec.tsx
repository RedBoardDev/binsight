import type { CreditDay } from '@app/applications/Shared/Chart/Domain/stackedBars';
import { StackedBarChart } from '@app/applications/Shared/Chart/Ui/StackedBarChart';
import { renderWithProviders } from '@test/renderWithProviders';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

const CYCLE = { start: '2026-10-17T00:00:00Z', end: '2026-11-17T00:00:00Z' };
const DAYS: readonly CreditDay[] = [
  { day: '2026-10-17', used: 40, segments: [10, 20, 5, 5] },
  { day: '2026-11-01', used: 120, segments: [60, 20, 30, 10] },
  { day: '2026-11-16', used: 0, segments: [0, 0, 0, 0] },
];

const TestCredits = ({
  days = DAYS,
  variant = 'neutral',
  onScrub = () => undefined,
}: {
  readonly days?: readonly CreditDay[];
  readonly variant?: 'neutral' | 'stacked';
  readonly onScrub?: (index: number | null) => void;
}) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const reading = (index: number) =>
    `${days[index]?.day}: ${days[index]?.used} credits; server daily budget 100`;
  return (
    <StackedBarChart
      days={days}
      cycle={CYCLE}
      dailyBudget={100}
      todayIndex={1}
      variant={variant}
      label="Provider credits"
      summary="Three supplied billing-cycle days"
      activeIndex={activeIndex}
      onScrub={(index) => {
        setActiveIndex(index);
        onScrub(index);
      }}
      describePoint={reading}
      renderReadout={(index) => <span>{reading(index)}</span>}
      formatDay={(index) => days[index]?.day ?? ''}
    />
  );
};

describe('StackedBarChart', () => {
  it('draws neutral health bars with only the explicit today accented and a dotted budget', () => {
    renderWithProviders(<TestCredits />);
    const svg = screen.getByRole('img');
    const rects = svg.querySelectorAll('rect');
    expect(rects).toHaveLength(3);
    expect(rects[0]).toHaveAttribute('fill', 'var(--n-500)');
    expect(rects[1]).toHaveAttribute('fill', 'var(--accent)');
    expect(svg.querySelector('line[stroke-dasharray]')).toHaveAttribute('stroke-dasharray', '3 4');
    expect(svg).not.toHaveTextContent('realtime');
    expect(screen.getByRole('table').parentElement).toHaveClass('sr-only');
  });

  it('draws the supplied priority segments only in the generic stacked variant', () => {
    renderWithProviders(<TestCredits variant="stacked" />);
    expect(screen.getByRole('img').querySelectorAll('rect')).toHaveLength(12);
    expect(screen.getByRole('img').querySelector('rect')).toHaveAttribute('fill', 'var(--accent)');
  });

  it('scrubs actual server days across months and announces caller totals without inventing missing dates', async () => {
    const onScrub = vi.fn();
    renderWithProviders(<TestCredits onScrub={onScrub} />);
    const slider = screen.getByRole('slider');
    const user = userEvent.setup();
    await user.click(slider);
    await user.keyboard('{Home}{ArrowRight}');
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      '2026-11-01: 120 credits; server daily budget 100',
    );
    await user.keyboard('{End}');
    expect(slider).toHaveAttribute('aria-valuenow', '2');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4);
    expect(screen.getByRole('table')).not.toHaveTextContent('2026-10-18');
    fireEvent.pointerLeave(slider, { pointerType: 'mouse' });
    expect(onScrub).toHaveBeenLastCalledWith(null);
  });

  it('disables empty cycle data without hiding the supplied budget line', () => {
    renderWithProviders(<TestCredits days={[]} />);
    expect(screen.getByRole('slider')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('slider')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('img').querySelectorAll('rect')).toHaveLength(0);
    expect(screen.getByRole('img').querySelector('line[stroke-dasharray]')).toBeInTheDocument();
  });
});
