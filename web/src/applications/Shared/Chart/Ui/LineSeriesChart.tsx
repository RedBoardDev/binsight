import { axisLabels } from '@app/applications/Shared/Chart/Domain/axisLabels';
import { lineSeriesGeometry } from '@app/applications/Shared/Chart/Domain/lineSeriesGeometry';
import type { PulsePoint } from '@app/applications/Shared/Chart/Domain/pulseGeometry';
import { ChartReadings } from '@app/applications/Shared/Chart/Ui/ChartReadings';
import { useElementWidth } from '@app/applications/Shared/Chart/Ui/useElementWidth';
import { useScrubIndex } from '@app/applications/Shared/Chart/Ui/useScrubIndex';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useId, useMemo } from 'react';

const DEFAULT_LINE_HEIGHT_PX = 236;
const DATE_BOTTOM_PADDING_PX = 22;
const DATE_EDGE_PADDING_PX = 24;
const DATE_BASELINE_PADDING_PX = 6;
const LINE_STROKE_WIDTH_PX = 1.5;
const LAST_POINT_RADIUS_PX = 3;
const SELECTED_POINT_RADIUS_PX = 4;
const LINE_PADDING_PX = 10;
const COMPACT_CHART_WIDTH_PX = 520;

interface LineSeriesChartProps {
  readonly points: readonly Pick<PulsePoint, 'start' | 'line'>[];
  readonly label: string;
  readonly summary: string;
  readonly activeIndex: number | null;
  readonly onScrub: (index: number | null) => void;
  readonly renderReadout: (index: number) => ReactNode;
  readonly describePoint: (index: number) => string;
  readonly height?: number;
}

export const LineSeriesChart = ({
  points,
  label,
  summary,
  activeIndex,
  onScrub,
  renderReadout,
  describePoint,
  height = DEFAULT_LINE_HEIGHT_PX,
}: LineSeriesChartProps) => {
  const { t } = useLingui();
  const { ref, width } = useElementWidth();
  const { formatShortDate } = useDateFormatters();
  const instructionsId = useId();
  const plotHeight = height - DATE_BOTTOM_PADDING_PX;
  const geometry = useMemo(
    () =>
      lineSeriesGeometry(
        points.map((point) => point.line),
        plotHeight,
        width,
        LINE_PADDING_PX,
      ),
    [points, plotHeight, width],
  );
  const selectedIndex =
    activeIndex !== null && points[activeIndex] !== undefined ? activeIndex : null;
  const announcedIndex = selectedIndex ?? Math.max(0, points.length - 1);
  const events = useScrubIndex({
    positions: geometry.positions,
    width,
    activeIndex: selectedIndex,
    onScrub,
  });
  const selected = geometry.points[selectedIndex ?? points.length - 1];
  const first = geometry.points[0];
  const cursorX = selectedIndex === null ? undefined : geometry.positions[selectedIndex];
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
          {first !== undefined && first.exactness !== 'unavailable' && (
            <line
              x1={0}
              x2={width}
              y1={first.point.y}
              y2={first.point.y}
              stroke="var(--border)"
              strokeDasharray="2 5"
            />
          )}
          <g
            fill="none"
            stroke="var(--accent)"
            strokeWidth={LINE_STROKE_WIDTH_PX}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {geometry.strokes.map((stroke) => (
              <path
                key={stroke.path}
                d={stroke.path}
                strokeDasharray={stroke.style === 'dashed' ? '4 4' : undefined}
              />
            ))}
          </g>
          {cursorX !== undefined && (
            <line
              x1={cursorX}
              x2={cursorX}
              y1={0}
              y2={plotHeight}
              stroke="var(--faint)"
              strokeOpacity={0.45}
            />
          )}
          {selected !== undefined && selected.exactness !== 'unavailable' && (
            <circle
              cx={selected.point.x}
              cy={selected.point.y}
              r={selectedIndex === null ? LAST_POINT_RADIUS_PX : SELECTED_POINT_RADIUS_PX}
              fill="var(--accent)"
              stroke="var(--background)"
              strokeWidth={selectedIndex === null ? 0 : 2}
            />
          )}
          {axisLabels(points.length, width < COMPACT_CHART_WIDTH_PX ? 3 : 5).map((index) => {
            const point = points[index];
            const x = geometry.positions[index];
            return point === undefined || x === undefined ? null : (
              <text
                key={point.start}
                x={Math.max(DATE_EDGE_PADDING_PX, Math.min(width - DATE_EDGE_PADDING_PX, x))}
                y={height - DATE_BASELINE_PADDING_PX}
                textAnchor="middle"
                className="text-label"
                fill="var(--faint)"
              >
                {formatShortDate(point.start)}
              </text>
            );
          })}
        </svg>
        <div
          {...events}
          role="slider"
          tabIndex={points.length === 0 ? -1 : 0}
          aria-label={label}
          aria-describedby={instructionsId}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, points.length - 1)}
          aria-valuenow={announcedIndex}
          aria-valuetext={points.length === 0 ? t`No chart values` : describePoint(announcedIndex)}
          aria-disabled={points.length === 0}
          className="absolute inset-0 cursor-crosshair touch-pan-y"
        />
      </div>
      <p
        id={instructionsId}
        className="sr-only"
      >{t`Use the arrow keys to explore the chart. Home and End select the first and last readings.`}</p>
      <ChartReadings
        keys={points.map((point) => point.start)}
        label={label}
        describePoint={describePoint}
      />
    </figure>
  );
};
