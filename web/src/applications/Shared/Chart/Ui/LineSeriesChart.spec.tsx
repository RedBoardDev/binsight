import type { PulsePoint } from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import { LineSeriesChart } from '@app/applications/Shared/Chart/Ui/LineSeriesChart';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { renderWithProviders } from '@test/renderWithProviders';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const money = (amount: string): Figure => {
  const parsed = parseDecimalString(amount);
  if (parsed === null) throw new Error('A fixture needs a canonical amount');
  return { exactness: 'complete', value: { amount: parsed, unit: 'sol' } };
};
const POINTS: readonly PulsePoint[] = [
  { start: '2026-10-01T00:00:00Z', line: money('100') },
  { start: '2026-10-02T00:00:00Z', line: { exactness: 'unavailable', reasons: [] } },
  { start: '2026-10-03T00:00:00Z', line: money('9007199254740993.123456789') },
];

const TestLine = ({
  points = POINTS,
  onScrub = () => undefined,
}: {
  readonly points?: readonly PulsePoint[];
  readonly onScrub?: (index: number | null) => void;
}) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isHidden = displayPreferenceStore.getSnapshot().areAmountsHidden;
  const reading = (index: number) => {
    const point = points[index];
    return point === undefined || point.line.exactness === 'unavailable'
      ? 'Unavailable'
      : `Net worth: ${isHidden ? '•••' : point.line.value.amount} SOL; Change: +2.41%`;
  };
  return (
    <LineSeriesChart
      points={points}
      label="Net worth"
      summary="Three server net worth readings"
      activeIndex={activeIndex}
      onScrub={(index) => {
        setActiveIndex(index);
        onScrub(index);
      }}
      renderReadout={(index) => <span>{reading(index)}</span>}
      describePoint={reading}
    />
  );
};

afterEach(() => displayPreferenceStore.setAmountsHidden(false));

describe('LineSeriesChart', () => {
  it('reads every server index by keyboard including missing figures and exact large decimal strings', async () => {
    const onScrub = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TestLine onScrub={onScrub} />);
    const slider = screen.getByRole('slider', { name: 'Net worth' });
    await user.click(slider);
    await user.keyboard('{Home}');
    expect(slider).toHaveAttribute('aria-valuetext', 'Net worth: 100 SOL; Change: +2.41%');
    await user.keyboard('{ArrowRight}');
    expect(slider).toHaveAttribute('aria-valuetext', 'Unavailable');
    await user.keyboard('{End}');
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      'Net worth: 9007199254740993.123456789 SOL; Change: +2.41%',
    );
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4);
    await user.keyboard('{Escape}');
    expect(onScrub).toHaveBeenLastCalledWith(null);
  });

  it('uses masked caller readings in the readout, speech and equivalent table while preserving percentages', async () => {
    displayPreferenceStore.setAmountsHidden(true);
    renderWithProviders(<TestLine />);
    const slider = screen.getByRole('slider');
    const user = userEvent.setup();
    await user.click(slider);
    await user.keyboard('{End}');
    expect(slider).toHaveAttribute('aria-valuetext', 'Net worth: ••• SOL; Change: +2.41%');
    expect(screen.getByRole('table')).not.toHaveTextContent('9007199254740993');
    expect(screen.getByRole('table')).toHaveTextContent('+2.41%');
  });

  it('cuts unavailable gaps and retains the date axis without creating monetary axis labels', () => {
    const { container } = renderWithProviders(<TestLine />);
    const svg = screen.getByRole('img', { name: 'Three server net worth readings' });
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(svg.querySelectorAll('text')).toHaveLength(3);
    expect(svg.textContent).not.toContain('100');
    const table = screen.getByRole('table');
    expect(table.parentElement).toHaveClass('sr-only');
    expect(container.querySelector('[role="slider"]')).toHaveClass('touch-pan-y');
  });

  it('disables an empty chart without emitting a scrub index', () => {
    const onScrub = vi.fn();
    renderWithProviders(<TestLine points={[]} onScrub={onScrub} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(slider).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onScrub).not.toHaveBeenCalled();
  });
});
