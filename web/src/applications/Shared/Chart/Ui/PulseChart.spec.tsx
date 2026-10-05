import type { PulsePoint } from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import { PulseChart } from '@app/applications/Shared/Chart/Ui/PulseChart';
import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Figure, PercentFigure } from '@app/applications/Shared/Figure/Domain/figure';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { speakFigure } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { displayPreferenceStore } from '@app/applications/Shared/Preference/Ui/displayPreferenceStore';
import { useLingui } from '@lingui/react/macro';
import { renderWithProviders } from '@test/renderWithProviders';
import { createEvent, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decimal = (value: string) => {
  const parsed = parseDecimalString(value);
  if (parsed === null) throw new Error('A test needs a canonical decimal');
  return parsed;
};
const money = (amount: string): Figure => ({
  exactness: 'complete',
  value: { amount: decimal(amount), unit: 'sol' },
});
const POINTS: readonly PulsePoint[] = [
  { start: '2026-10-01T00:00:00Z', bar: money('0.4215'), line: money('1.8327') },
  { start: '2026-10-02T00:00:00Z', bar: money('-0.21'), line: money('1.6227') },
  {
    start: '2026-10-03T00:00:00Z',
    bar: money('9007199254740993.123456789'),
    line: money('9007199254740994.746156789'),
  },
];
const SHARE: PercentFigure = { exactness: 'complete', value: decimal('2.41') };
const CUMULATIVE_SHARE: PercentFigure = { exactness: 'complete', value: decimal('20.4') };

const TestPulse = ({
  points = POINTS,
  onScrub = () => undefined,
}: {
  readonly points?: readonly PulsePoint[];
  readonly onScrub?: (index: number | null) => void;
}) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const format = useFigureFormatter();
  const { i18n } = useLingui();
  const spokenAmount = (figure: Figure | null | undefined) =>
    speakFigure(i18n, {
      formatted:
        figure === undefined || figure === null || figure.exactness === 'unavailable'
          ? null
          : format.amount(figure.value, 'body', 'always'),
      unit: 'sol',
      exactness: figure?.exactness ?? 'unavailable',
      isHidden: format.areAmountsHidden,
    });
  const spokenPercent = (figure: PercentFigure) =>
    figure.exactness === 'unavailable'
      ? 'not available'
      : speakFigure(i18n, {
          formatted: format.percent(figure.value, 'cell', 'always'),
          unit: null,
          exactness: figure.exactness,
          isHidden: false,
        });
  return (
    <PulseChart
      points={points}
      label="Real PnL"
      summary="Daily and cumulative profit over three days"
      activeIndex={activeIndex}
      onScrub={(index) => {
        setActiveIndex(index);
        onScrub(index);
      }}
      describePoint={(index) =>
        `day ${index + 1}; Profit: ${spokenAmount(points[index]?.bar)}; vs net worth: ${spokenPercent(SHARE)}; Cumulative: ${spokenAmount(points[index]?.line)}; vs net worth: ${spokenPercent(CUMULATIVE_SHARE)}`
      }
      renderReadout={(index) => {
        const point = points[index];
        return point === undefined || point.bar === undefined || point.bar === null ? null : (
          <div data-testid="readout">
            <span>Profit </span>
            <FigureAmount figure={point.bar} placement="body" signing="always" />
            <span> vs net worth </span>
            <PercentValue figure={SHARE} placement="cell" signing="always" />
            <span> Cumulative </span>
            <FigureAmount figure={point.line} placement="body" signing="always" />
            <span> vs net worth </span>
            <PercentValue figure={CUMULATIVE_SHARE} placement="cell" signing="always" />
          </div>
        );
      }}
    />
  );
};

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
    this.pointerType = options.pointerType ?? 'mouse';
    this.isPrimary = options.isPrimary ?? true;
  }
}

const chartBox = (slider: HTMLElement) => {
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 236));
};

describe('PulseChart', () => {
  beforeEach(() => vi.stubGlobal('PointerEvent', TestPointerEvent));
  afterEach(() => displayPreferenceStore.setAmountsHidden(false));

  it('exposes its summary and equivalent table of four server readings', () => {
    renderWithProviders(<TestPulse />);
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Daily and cumulative profit over three days',
    );
    const table = screen.getByRole('table', { name: 'Real PnL' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(table).toHaveTextContent(
      'Profit: plus 0.422 SOL; vs net worth: plus 2.41%; Cumulative: plus 1.833 SOL; vs net worth: plus 20.40%',
    );
  });

  it('scrubs with arrows, Home and End and keeps exact strings in the readout', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TestPulse />);
    await user.tab();
    const slider = screen.getByRole('slider');
    expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByTestId('readout')).toHaveTextContent('9,007,199,254,740,993.12');
    await user.keyboard('{Home}{ArrowRight}');
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Profit: minus 0.210 SOL'),
    );
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    await user.keyboard('{End}{ArrowRight}');
    expect(slider).toHaveAttribute('aria-valuenow', '2');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('readout')).not.toBeInTheDocument();
    expect(slider.closest('figure')?.querySelector('[aria-live]')).toBeNull();
  });

  it('hides amounts in the visual readout, slider speech and table while retaining percentages', async () => {
    displayPreferenceStore.setAmountsHidden(true);
    renderWithProviders(<TestPulse />);
    await userEvent.setup().tab();
    expect(screen.getByTestId('readout')).toHaveTextContent('•••••');
    expect(screen.getByTestId('readout')).toHaveTextContent('+2.41%');
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('amount hidden SOL'),
    );
    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('amount hidden SOL');
    expect(table).not.toHaveTextContent('9,007,199');
    expect(table).not.toHaveTextContent('0.422');
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).not.toContain('9,007,199');
  });

  it('chooses a mouse sample and clears it when the pointer leaves', () => {
    const onScrub = vi.fn();
    renderWithProviders(<TestPulse onScrub={onScrub} />);
    const slider = screen.getByRole('slider');
    chartBox(slider);
    fireEvent.pointerMove(slider, { pointerType: 'mouse', clientX: 140 });
    expect(onScrub).toHaveBeenLastCalledWith(1);
    fireEvent.pointerLeave(slider, { pointerType: 'mouse' });
    expect(onScrub).toHaveBeenLastCalledWith(null);
  });

  it('waits for horizontal touch movement and releases capture on cancellation', () => {
    const onScrub = vi.fn();
    renderWithProviders(<TestPulse onScrub={onScrub} />);
    const slider = screen.getByRole('slider');
    chartBox(slider);
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(slider, {
      setPointerCapture: capture,
      hasPointerCapture: () => true,
      releasePointerCapture: release,
    });
    fireEvent.pointerDown(slider, {
      pointerType: 'touch',
      clientX: 140,
      clientY: 10,
      pointerId: 7,
    });
    fireEvent.pointerMove(slider, {
      pointerType: 'touch',
      clientX: 149,
      clientY: 12,
      pointerId: 7,
    });
    expect(onScrub).not.toHaveBeenCalled();
    fireEvent.pointerMove(slider, {
      pointerType: 'touch',
      clientX: 165,
      clientY: 12,
      pointerId: 7,
    });
    expect(capture).toHaveBeenCalledWith(7);
    expect(onScrub).toHaveBeenLastCalledWith(1);
    fireEvent.pointerCancel(slider, { pointerType: 'touch', pointerId: 7 });
    expect(release).toHaveBeenCalledWith(7);
    expect(onScrub).toHaveBeenLastCalledWith(null);
    onScrub.mockClear();
    fireEvent.pointerMove(slider, {
      pointerType: 'touch',
      clientX: 250,
      clientY: 20,
      pointerId: 7,
    });
    expect(onScrub).not.toHaveBeenCalled();
  });

  it('leaves vertical scrolling native before the threshold and after cancellation', () => {
    const onScrub = vi.fn();
    renderWithProviders(<TestPulse onScrub={onScrub} />);
    const slider = screen.getByRole('slider');
    chartBox(slider);
    fireEvent.pointerDown(slider, { pointerType: 'touch', clientX: 140, clientY: 10 });
    const movement = createEvent.pointerMove(slider, {
      pointerType: 'touch',
      clientX: 142,
      clientY: 35,
      cancelable: true,
    });
    fireEvent(slider, movement);
    fireEvent.pointerMove(slider, { pointerType: 'touch', clientX: 200, clientY: 40 });
    expect(onScrub).not.toHaveBeenCalled();
    expect(movement.defaultPrevented).toBe(false);
    expect(slider).toHaveClass('touch-pan-y');
    fireEvent.pointerCancel(slider, { pointerType: 'touch' });
    onScrub.mockClear();
    fireEvent.pointerDown(slider, { pointerType: 'touch', clientX: 140, clientY: 10 });
    fireEvent.pointerMove(slider, { pointerType: 'touch', clientX: 142, clientY: 35 });
    expect(onScrub).not.toHaveBeenCalled();
  });

  it('keeps an empty chart out of keyboard navigation without inventing values', () => {
    renderWithProviders(<TestPulse points={[]} />);
    expect(screen.getByRole('slider')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('slider')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'No chart values');
  });
});
