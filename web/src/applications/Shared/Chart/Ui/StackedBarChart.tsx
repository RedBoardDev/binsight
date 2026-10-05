import {
  CREDIT_DATE_EDGE_PADDING_PX,
  type CreditCycle,
  type CreditDay,
  stackedBars,
} from '@app/applications/Shared/Chart/Domain/stackedBars';
import { ChartReadings } from '@app/applications/Shared/Chart/Ui/ChartReadings';
import { useElementWidth } from '@app/applications/Shared/Chart/Ui/useElementWidth';
import { useScrubIndex } from '@app/applications/Shared/Chart/Ui/useScrubIndex';
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useId, useMemo } from 'react';

const DEFAULT_CREDIT_HEIGHT_PX = 180;
const DATE_BASELINE_PADDING_PX = 6;
const STACK_TOKENS = ['--accent', '--foreground', '--muted', '--faint'] as const;

interface StackedBarChartProps {
  readonly days: readonly CreditDay[];
  readonly cycle: CreditCycle;
  readonly dailyBudget: number;
  readonly todayIndex: number | null;
  readonly variant?: 'neutral' | 'stacked';
  readonly label: string;
  readonly summary: string;
  readonly activeIndex: number | null;
  readonly onScrub: (index: number | null) => void;
  readonly renderReadout: (index: number) => ReactNode;
  readonly describePoint: (index: number) => string;
  readonly formatDay: (index: number) => string;
  readonly height?: number;
}

export const StackedBarChart = ({
  days,
  cycle,
  dailyBudget,
  todayIndex,
  variant = 'neutral',
  label,
  summary,
  activeIndex,
  onScrub,
  renderReadout,
  describePoint,
  formatDay,
  height = DEFAULT_CREDIT_HEIGHT_PX,
}: StackedBarChartProps) => {
  const { t } = useLingui();
  const { ref, width } = useElementWidth();
  const instructionsId = useId();
  const geometry = useMemo(
    () => stackedBars(days, { cycle, dailyBudget, width, height }),
    [days, cycle, dailyBudget, width, height],
  );
  const selectedIndex =
    activeIndex !== null && days[activeIndex] !== undefined ? activeIndex : null;
  const announcedIndex = selectedIndex ?? Math.max(0, days.length - 1);
  const events = useScrubIndex({
    positions: geometry.positions,
    width,
    activeIndex: selectedIndex,
    onScrub,
  });
  return (
    <figure className="flex w-full flex-col gap-2" aria-label={label}>
      <figcaption className="flex min-h-14 items-center">
        {selectedIndex === null ? (
          <span className="text-body text-muted">{summary}</span>
        ) : (
          renderReadout(selectedIndex)
        )}
      </figcaption>
      <div ref={ref} className="relative w-full">
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block select-none"
          role="img"
          aria-label={summary}
        >
          <line
            x1={0}
            x2={width}
            y1={geometry.bottom}
            y2={geometry.bottom}
            stroke="var(--border)"
          />
          {geometry.bars.map((bar) => (
            <g
              key={bar.index}
              opacity={selectedIndex === null || selectedIndex === bar.index ? 1 : 0.55}
            >
              {variant === 'neutral' ? (
                <rect
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  fill={bar.index === todayIndex ? 'var(--accent)' : 'var(--n-500)'}
                />
              ) : (
                bar.segments.map((segment) => (
                  <rect
                    key={segment.index}
                    x={bar.x}
                    y={segment.y}
                    width={bar.width}
                    height={segment.height}
                    fill={`var(${STACK_TOKENS[segment.index % STACK_TOKENS.length]})`}
                  />
                ))
              )}
            </g>
          ))}
          <line
            x1={0}
            x2={width}
            y1={geometry.budgetY}
            y2={geometry.budgetY}
            stroke="var(--muted)"
            strokeDasharray="3 4"
          />
          {geometry.labels.map((index) => {
            const x = geometry.positions[index];
            return x === undefined ? null : (
              <text
                key={days[index]?.day}
                x={Math.max(
                  CREDIT_DATE_EDGE_PADDING_PX,
                  Math.min(width - CREDIT_DATE_EDGE_PADDING_PX, x),
                )}
                y={height - DATE_BASELINE_PADDING_PX}
                textAnchor="middle"
                className="text-label"
                fill="var(--faint)"
              >
                {formatDay(index)}
              </text>
            );
          })}
        </svg>
        <div
          {...events}
          role="slider"
          tabIndex={days.length === 0 ? -1 : 0}
          aria-label={label}
          aria-describedby={instructionsId}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, days.length - 1)}
          aria-valuenow={announcedIndex}
          aria-valuetext={days.length === 0 ? t`No chart values` : describePoint(announcedIndex)}
          aria-disabled={days.length === 0}
          className="absolute inset-0 cursor-crosshair touch-pan-y"
        />
      </div>
      <p
        id={instructionsId}
        className="sr-only"
      >{t`Use the arrow keys to explore the chart. Home and End select the first and last readings.`}</p>
      <ChartReadings
        keys={days.map((day) => day.day)}
        label={label}
        describePoint={describePoint}
      />
    </figure>
  );
};
