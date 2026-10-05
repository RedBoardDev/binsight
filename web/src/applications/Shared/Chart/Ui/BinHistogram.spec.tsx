import { type BinChartSource, binBars } from '@app/applications/Shared/Chart/Domain/binBars';
import { BinHistogram } from '@app/applications/Shared/Chart/Ui/BinHistogram';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { renderWithProviders } from '@test/renderWithProviders';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CHART: BinChartSource = {
  active_bin_id: 104,
  lower_bin_id: 0,
  upper_bin_id: 209,
  bars: Array.from({ length: 70 }, (_, index) => ({
    bin_id: index * 3,
    base: '9007199254740993.123456789',
    quote: '0',
    height: '1',
  })),
};

const TestBins = ({
  chart = CHART,
  read = () => undefined,
}: {
  readonly chart?: BinChartSource;
  readonly read?: (indices: readonly number[]) => void;
}) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const format = useFigureFormatter();
  const describeGroup = (indices: readonly number[]) =>
    indices
      .map((index) => {
        const bar = chart.bars[index];
        if (bar === undefined) throw new Error('A reading requires its original source');
        const amount = parseDecimalString(bar.base);
        if (amount === null) throw new Error('A reading requires its server decimal');
        return `Server group beginning at bin ${bar.bin_id}; first-bin price ${format.areAmountsHidden ? 'hidden' : '0.123'} SOL; base ${format.areAmountsHidden ? 'hidden' : format.tokenQuantity(amount)} token.`;
      })
      .join(' ');
  return (
    <BinHistogram
      chart={chart}
      label="Liquidity bins"
      summary="Liquidity by server group"
      lowerLabel="Lower"
      upperLabel="Upper"
      rangeLabel="210 bins · 10.6% wide"
      activeIndex={activeIndex}
      onScrub={setActiveIndex}
      renderGroup={(indices) => {
        read(indices);
        return <div data-testid="reading">{describeGroup(indices)}</div>;
      }}
      describeGroup={describeGroup}
    />
  );
};

describe('BinHistogram', () => {
  afterEach(() => displayPreferenceStore.setAmountsHidden(false));

  it('reads every server source in a drawn group without claiming a price average or an amount total', async () => {
    const read = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TestBins read={read} />);
    await user.tab();
    await user.keyboard('{Home}');
    const indices = binBars(CHART).bars[0]?.sourceIndices;
    expect(indices?.length).toBeGreaterThan(1);
    expect(read).toHaveBeenLastCalledWith(indices);
    const reading = screen.getByTestId('reading');
    for (const index of indices ?? [])
      expect(reading).toHaveTextContent(
        `Server group beginning at bin ${CHART.bars[index]?.bin_id}`,
      );
    expect(reading).toHaveTextContent('9007.2T');
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('first-bin price 0.123 SOL'),
    );
    const table = screen.getByRole('table', { name: 'Liquidity bins' });
    expect(within(table).getAllByRole('row')).toHaveLength(binBars(CHART).bars.length + 1);
    expect(table.parentElement).toHaveClass('sr-only');
    expect(table).toHaveTextContent('Server group beginning at bin 207');
  });

  it('preserves a caller-provided reading above the floating point precision limit', async () => {
    const user = userEvent.setup();
    const exact = '9007199254740993.123456789';
    renderWithProviders(
      <BinHistogram
        chart={CHART}
        label="Exact bins"
        summary="Exact server reading"
        lowerLabel="Lower"
        upperLabel="Upper"
        rangeLabel="Server range"
        activeIndex={0}
        onScrub={() => undefined}
        renderGroup={() => exact}
        describeGroup={() => exact}
      />,
    );
    await user.tab();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', exact);
    expect(screen.getByRole('table')).toHaveTextContent(exact);
    expect(screen.getByRole('figure')).toHaveTextContent(exact);
  });

  it('supports arrows and Home and End with focus and an index readout without live announcement noise', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TestBins />);
    await user.tab();
    const slider = screen.getByRole('slider');
    expect(slider).toHaveFocus();
    expect(slider.parentElement).toHaveStyle({ height: '72px' });
    await user.keyboard('{Home}{ArrowRight}');
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    await user.keyboard('{End}{ArrowRight}');
    expect(slider).toHaveAttribute('aria-valuenow', String(binBars(CHART).bars.length - 1));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('reading')).not.toBeInTheDocument();
    expect(slider.closest('figure')?.querySelector('[aria-live]')).toBeNull();
  });

  it('keeps caller-masked prices and quantities hidden in speech and the equivalent table', async () => {
    displayPreferenceStore.setAmountsHidden(true);
    const user = userEvent.setup();
    renderWithProviders(<TestBins />);
    await user.tab();
    await user.keyboard('{Home}');
    const figure = screen.getByRole('figure');
    expect(figure).toHaveTextContent('first-bin price hidden SOL; base hidden token');
    expect(figure).not.toHaveTextContent('0.123');
    expect(figure).not.toHaveTextContent('9,007,199');
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('base hidden token'),
    );
    expect(figure).toHaveTextContent('10.6% wide');
  });

  it('scrubs a mouse by the drawn positions and leaves native vertical touch scrolling available', () => {
    renderWithProviders(<TestBins />);
    const slider = screen.getByRole('slider');
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 600,
      height: 80,
      right: 600,
      bottom: 80,
      toJSON: () => undefined,
    });
    const event = new MouseEvent('pointermove', { bubbles: true, clientX: 5 });
    fireEvent(slider, event);
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(slider).toHaveClass('touch-pan-y');
    fireEvent.pointerLeave(slider);
    expect(screen.queryByTestId('reading')).not.toBeInTheDocument();
  });

  it('keeps an empty histogram out of keyboard navigation and does not invent bin readings', () => {
    renderWithProviders(<TestBins chart={{ ...CHART, bars: [] }} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('tabindex', '-1');
    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(slider).toHaveAttribute('aria-valuetext', 'Liquidity by server group');
    expect(screen.queryByTestId('reading')).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName('Liquidity by server group');
  });
});
